import type { DinksterConnection, MountSettings } from "@dinkster/client";
import { desktopBridge } from "./desktop-bridge.js";
import type { ExecutedImage } from "./executed-image-inventory.js";

export const canRevealOutput = (): boolean => desktopBridge() !== undefined;

export function outputHostPath(
  settings: MountSettings,
  virtualPath: string,
): string | undefined {
  const match = /^mounts\/([^/]+)\/(.+)$/.exec(virtualPath);
  if (match === null) return undefined;
  const relative = match[2]!;
  if (
    relative.includes("\\") ||
    relative
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  )
    return undefined;
  const root = settings.mounts.find((mount) => mount.id === match[1])?.path;
  if (root === undefined) return undefined;
  const separator = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[\\/]$/, "")}${separator}${relative.replaceAll("/", separator)}`;
}

export async function revealExecutedImage(
  connection: Pick<DinksterConnection, "fetchMountSettings">,
  image: ExecutedImage,
): Promise<void> {
  const bridge = desktopBridge();
  if (bridge === undefined || image.virtualPath === undefined) return;
  const path = outputHostPath(
    await connection.fetchMountSettings(),
    image.virtualPath,
  );
  if (path === undefined)
    throw new Error("The saved output is not in a mounted local folder.");
  await bridge.revealFile(path);
}
