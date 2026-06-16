export type TaglineMode = "random" | "default" | "off";

export type TaglineOptions = {
  mode?: TaglineMode;
  env?: NodeJS.ProcessEnv;
};

export function pickTagline(options: TaglineOptions = {}): string {
  if (options.mode === "off") {
    return "";
  }
  return "browser automation CLI";
}
