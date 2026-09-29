// DDC/CI monitor control, compiled on first use to a cached exe.
//
// The same work in PowerShell costs ~2.2s per call: ~0.5s interpreter startup
// plus ~1.7s for Add-Type to compile this C# afresh every single time. Paying
// the compile once and caching the exe brings a key press down to tens of
// milliseconds, which is the difference between a button and a wait.
//
// Talks to dxva2.dll directly so the plugin needs no native Node addon (whose
// ABI would have to match whichever Node the Stream Deck app ships) and no
// third-party binary.
//
// Usage:
//   ddcctl list
//   ddcctl get --match U2414H --code 0x60
//   ddcctl set --match U2414H --code 0x60 --value 17
//
// Prints a single line of JSON. Exit code 0 on success, 1 on failure.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

internal static class DdcCtl
{
	[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
	private struct PHYSICAL_MONITOR
	{
		public IntPtr hPhysicalMonitor;
		[MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
		public string szPhysicalMonitorDescription;
	}

	private delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, IntPtr lprc, IntPtr data);

	[DllImport("user32.dll")]
	private static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc proc, IntPtr data);

	[DllImport("dxva2.dll", SetLastError = true)]
	private static extern bool GetNumberOfPhysicalMonitorsFromHMONITOR(IntPtr hMonitor, ref uint count);

	[DllImport("dxva2.dll", SetLastError = true)]
	private static extern bool GetPhysicalMonitorsFromHMONITOR(IntPtr hMonitor, uint count, [Out] PHYSICAL_MONITOR[] monitors);

	[DllImport("dxva2.dll", SetLastError = true)]
	private static extern bool DestroyPhysicalMonitors(uint count, PHYSICAL_MONITOR[] monitors);

	[DllImport("dxva2.dll", SetLastError = true)]
	private static extern bool GetCapabilitiesStringLength(IntPtr handle, ref uint length);

	[DllImport("dxva2.dll", SetLastError = true)]
	private static extern bool CapabilitiesRequestAndCapabilitiesReply(IntPtr handle, StringBuilder buffer, uint length);

	[DllImport("dxva2.dll", SetLastError = true)]
	private static extern bool GetVCPFeatureAndVCPFeatureReply(IntPtr handle, byte code, IntPtr type, ref uint current, ref uint max);

	[DllImport("dxva2.dll", SetLastError = true)]
	private static extern bool SetVCPFeature(IntPtr handle, byte code, uint value);

	private static List<PHYSICAL_MONITOR> All()
	{
		var found = new List<PHYSICAL_MONITOR>();
		MonitorEnumProc proc = delegate(IntPtr hMonitor, IntPtr hdc, IntPtr lprc, IntPtr data)
		{
			uint count = 0;
			if (GetNumberOfPhysicalMonitorsFromHMONITOR(hMonitor, ref count) && count > 0)
			{
				var block = new PHYSICAL_MONITOR[count];
				if (GetPhysicalMonitorsFromHMONITOR(hMonitor, count, block))
				{
					found.AddRange(block);
				}
			}
			return true;
		};
		EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, proc, IntPtr.Zero);
		return found;
	}

	private static string Capabilities(IntPtr handle)
	{
		uint length = 0;
		if (!GetCapabilitiesStringLength(handle, ref length) || length == 0)
		{
			return null;
		}
		var buffer = new StringBuilder((int)length);
		return CapabilitiesRequestAndCapabilitiesReply(handle, buffer, length) ? buffer.ToString() : null;
	}

	private static string Json(string value)
	{
		if (value == null)
		{
			return "null";
		}
		var sb = new StringBuilder("\"");
		foreach (char c in value)
		{
			switch (c)
			{
				case '"': sb.Append("\\\""); break;
				case '\\': sb.Append("\\\\"); break;
				case '\n': sb.Append("\\n"); break;
				case '\r': sb.Append("\\r"); break;
				case '\t': sb.Append("\\t"); break;
				default:
					if (c < 0x20) { sb.Append("\\u").Append(((int)c).ToString("x4")); }
					else { sb.Append(c); }
					break;
			}
		}
		return sb.Append('"').ToString();
	}

	private static string Arg(string[] args, string name, string fallback)
	{
		for (int i = 0; i < args.Length - 1; i++)
		{
			if (string.Equals(args[i], "--" + name, StringComparison.OrdinalIgnoreCase))
			{
				return args[i + 1];
			}
		}
		return fallback;
	}

	private static byte ParseCode(string text)
	{
		if (text.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
		{
			return Convert.ToByte(text.Substring(2), 16);
		}
		return byte.Parse(text, CultureInfo.InvariantCulture);
	}

	/// Prefers matching the capability string (which carries the model) over a
	/// positional index, because EnumDisplayMonitors order moves when displays
	/// are rearranged or hot-plugged and would silently target the wrong panel.
	///
	/// Reading a capability string is a slow multi-packet I2C transfer: ~1450ms
	/// versus ~95ms for a plain get/set. Callers should resolve by match once,
	/// cache the index, and fall back to re-resolving when the monitor count
	/// changes or a call fails — which is what the Node side does.
	private static int Resolve(List<PHYSICAL_MONITOR> monitors, string match, int index)
	{
		if (string.IsNullOrEmpty(match))
		{
			return index;
		}
		for (int i = 0; i < monitors.Count; i++)
		{
			string caps = Capabilities(monitors[i].hPhysicalMonitor);
			if (caps != null && caps.IndexOf(match, StringComparison.OrdinalIgnoreCase) >= 0)
			{
				return i;
			}
		}
		throw new Exception("No monitor's capability string contains '" + match + "'");
	}

	private static int Main(string[] args)
	{
		List<PHYSICAL_MONITOR> monitors = null;
		try
		{
			string action = args.Length > 0 ? args[0].ToLowerInvariant() : "list";
			monitors = All();
			if (monitors.Count == 0)
			{
				throw new Exception("No physical monitors found");
			}

			string match = Arg(args, "match", "");
			int index = int.Parse(Arg(args, "index", "0"), CultureInfo.InvariantCulture);
			byte code = ParseCode(Arg(args, "code", "0x60"));

			if (action == "list")
			{
				var sb = new StringBuilder("{\"ok\":true,\"monitors\":[");
				for (int i = 0; i < monitors.Count; i++)
				{
					uint cur = 0, max = 0;
					bool ok = GetVCPFeatureAndVCPFeatureReply(monitors[i].hPhysicalMonitor, 0x60, IntPtr.Zero, ref cur, ref max);
					if (i > 0) { sb.Append(','); }
					sb.Append("{\"index\":").Append(i)
					  .Append(",\"description\":").Append(Json(monitors[i].szPhysicalMonitorDescription))
					  .Append(",\"capabilities\":").Append(Json(Capabilities(monitors[i].hPhysicalMonitor)))
					  .Append(",\"inputSource\":").Append(ok ? "{\"current\":" + cur + ",\"max\":" + max + "}" : "null")
					  .Append('}');
				}
				Console.Out.WriteLine(sb.Append("]}").ToString());
				return 0;
			}

			int target = Resolve(monitors, match, index);
			if (target < 0 || target >= monitors.Count)
			{
				throw new Exception("Monitor index " + target + " out of range (found " + monitors.Count + ")");
			}
			IntPtr handle = monitors[target].hPhysicalMonitor;

			if (action == "get")
			{
				uint cur = 0, max = 0;
				if (!GetVCPFeatureAndVCPFeatureReply(handle, code, IntPtr.Zero, ref cur, ref max))
				{
					throw new Exception("Monitor " + target + " did not answer VCP 0x" + code.ToString("X2"));
				}
				Console.Out.WriteLine("{\"ok\":true,\"monitors\":" + monitors.Count + ",\"index\":" + target + ",\"code\":" + code + ",\"current\":" + cur + ",\"max\":" + max + "}");
				return 0;
			}

			if (action == "set")
			{
				uint value = uint.Parse(Arg(args, "value", "0"), CultureInfo.InvariantCulture);
				if (!SetVCPFeature(handle, code, value))
				{
					throw new Exception("Monitor " + target + " rejected VCP 0x" + code.ToString("X2") + " = " + value);
				}
				Console.Out.WriteLine("{\"ok\":true,\"monitors\":" + monitors.Count + ",\"index\":" + target + ",\"code\":" + code + ",\"value\":" + value + "}");
				return 0;
			}

			throw new Exception("Unknown action '" + action + "'");
		}
		catch (Exception ex)
		{
			Console.Out.WriteLine("{\"ok\":false,\"error\":" + Json(ex.Message) + "}");
			return 1;
		}
		finally
		{
			if (monitors != null && monitors.Count > 0)
			{
				DestroyPhysicalMonitors((uint)monitors.Count, monitors.ToArray());
			}
		}
	}
}
