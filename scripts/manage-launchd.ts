import {
  installLaunchAgent,
  launchAgentStatus,
  uninstallLaunchAgent,
  upgradeLaunchAgent,
} from "../src/launchd.ts";

const action = process.argv[2];
const configPath = process.argv[3];

let status;
if (action === "status") {
  status = await launchAgentStatus();
} else if (action === "uninstall") {
  status = await uninstallLaunchAgent();
} else if (action === "install" || action === "upgrade") {
  if (configPath === undefined) throw new Error(`usage: manage-launchd ${action} CONFIG`);
  status = action === "install"
    ? await installLaunchAgent(configPath)
    : await upgradeLaunchAgent(configPath);
} else {
  throw new Error("usage: manage-launchd <install|upgrade|status|uninstall> [CONFIG]");
}

console.log(JSON.stringify(status, null, 2));
