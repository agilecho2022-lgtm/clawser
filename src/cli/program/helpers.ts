export function resolveActionArgs(actionCommand?: import("commander").Command): string[] {
  if (!actionCommand) {
    return [];
  }
  const args = (actionCommand as import("commander").Command & { args?: string[] }).args;
  return Array.isArray(args) ? args : [];
}
