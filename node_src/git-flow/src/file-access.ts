/**
 * The file seam, injected like the process seam.
 *
 * The ignore guard has to append a line to a tracked `.gitignore`. Inside the
 * harness that write belongs on `ctx.fs`, which is the seam that enforces the
 * session's sandbox policy — but `ctx.fs` writes a whole file and has no append,
 * and the committed tests must run with no harness at all. So the guard is
 * written against this two-method interface:
 *
 * - **in the harness**, over `ctx.fs`, passing the policy resolved for the
 *   calling session explicitly (without it, `dsh-fs-sandbox` falls back to the
 *   *deployment* policy rather than the session's, which would fence a write the
 *   session itself is allowed to make);
 * - **in the tests**, over `node:fs`, atomically, with no harness present.
 *
 * @module @dsh-external/dotdsh-git-flow/file-access
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Reading and replacing whole text files. */
export interface FileAccess {
  /**
   * Read a text file.
   *
   * @param path - absolute path to read.
   * @param signal - optional cancellation.
   * @returns the file's contents, or `undefined` when it does not exist.
   */
  read(path: string, signal?: AbortSignal): Promise<string | undefined>;
  /**
   * Replace a text file, creating it and its parent directory as needed.
   *
   * @param path - absolute path to write.
   * @param content - the complete new contents.
   * @param signal - optional cancellation.
   */
  write(path: string, content: string, signal?: AbortSignal): Promise<void>;
}

/**
 * A {@link FileAccess} over `node:fs`, writing through a temporary file and a
 * rename so a reader never observes a half-written file.
 *
 * This is the implementation the committed tests use.
 */
export const nodeFileAccess: FileAccess = {
  async read(path) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  },
  async write(path, content) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.dsh-git-flow.tmp`;
    await writeFile(temporary, content, "utf8");
    await rename(temporary, path);
  },
};
