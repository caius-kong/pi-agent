import { getPackageDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAutoCompact } from "./controller.mjs";

const loadCompactionModule = async () => {
  const packageDir = getPackageDir();
  return import(`${packageDir}/dist/core/compaction/compaction.js`);
};

export default function (pi: ExtensionAPI) {
  registerAutoCompact(pi, { loadCompactionModule });
}
