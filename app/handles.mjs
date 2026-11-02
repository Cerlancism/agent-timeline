// Small read-only helpers over directory and file handles, shared by the harness-neutral directory
// layer (localfs.mjs) and each harness's discovery (claude-fs.mjs, codex-fs.mjs). The handles are
// the browser's File System Access handles or the Node stand-ins in server.mjs.

/** [name, handle] pairs of a directory, or none when it cannot be read. */
export async function entries(dir) {
  const out = [];
  try {
    for await (const [name, handle] of dir.entries()) out.push([name, handle]);
  } catch {
    /* unreadable directory */
  }
  return out;
}

/** The file behind a handle with its size and modification time. */
export async function fileInfo(handle) {
  const f = await handle.getFile();
  return { file: f, size: f.size, mtime: f.lastModified };
}
