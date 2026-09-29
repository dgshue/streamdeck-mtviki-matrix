import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";

const sdPlugin = "com.dgshue.mtviki.sdPlugin";

export default {
  input: "src/plugin.ts",
  output: {
    file: `${sdPlugin}/bin/plugin.js`,
    sourcemap: true,
    sourcemapPathTransform: (relative, sourcemapPath) => {
      // Fix source paths so debugging maps back to src/.
      return relative.replace(/^(\.\.\/)+/, "");
    },
  },
  plugins: [
    { name: "watch-externals", buildStart() { this.addWatchFile(`${sdPlugin}/manifest.json`); } },
    {
      // The bundle is ESM, so Node needs "type": "module" beside it or it will
      // parse plugin.js as CommonJS and fail on the first import.
      name: "emit-module-marker",
      generateBundle() {
        this.emitFile({ type: "asset", fileName: "package.json", source: '{ "type": "module" }\n' });
      },
    },
    typescript({ mapRoot: "./" }),
    nodeResolve({ browser: false, exportConditions: ["node"], preferBuiltins: true }),
    commonjs(),
  ],
};
