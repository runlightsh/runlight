/**
 * One part of a URL path with its percent escapes decoded, or null when they are broken (such as %E0 or
 * %zz). A route answers null as it does a name it does not know, never with an error.
 */
export function decodePart(part: string): string | null {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
}
