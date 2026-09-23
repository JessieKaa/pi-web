/** `/auto-compact`, `/auto-compact on`, or `/auto-compact off`. */
export function nextAutoCompactionEnabled(current: boolean, arg: string): boolean | null {
  const value = arg.trim().toLowerCase();
  if (!value) return !current;
  if (value === "on" || value === "true") return true;
  if (value === "off" || value === "false") return false;
  return null;
}
