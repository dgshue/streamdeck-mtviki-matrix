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
    typescript({ mapRoot: "./" }),
    nodeResolve({ browser: false, exportConditions: ["node"], preferBuiltins: true }),
    commonjs(),
  ],
};
