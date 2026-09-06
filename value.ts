import * as p from "@clack/prompts";
import { readFile } from "node:fs/promises";
import { logError } from "./trace.ts";
import { type Params, substituteVariables, runShell } from "./step.ts";

export interface Variable {
  name: string;
  value?: string;
  valueFrom?: string;
  // Fallback when the `valueFrom:` source is unavailable
  // (`arg:` without matching `--set`, `env:` unset, missing file/key).
  default?: string;
}

// Native interpreter for `valueFrom: "ask <command> ..."`
// Reserved word `ask` routes to in-process prompts (@clack/prompts)
// instead of spawning a subprocess (with `gum ...`)
const ASK_ALIASES: Record<string, string> = {
  choose: "select",
  multi: "multiselect",
  input: "text",
};

export function isAskCommand(valueFrom: string): boolean {
  return /^ask\s+\S/.test(valueFrom.trim());
}

export function tokenizeAskArgs(input: string): string[] {
  const args: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    args.push(m[1] ?? m[2] ?? m[3]);
  }
  return args;
}

function requireTTY(command: string): void {
  if (!process.stdin.isTTY) {
    logError(`"ask ${command}" requires an interactive terminal (no TTY detected).`);
    process.exit(1);
  }
}

function handleAskCancel(variableName: string): never {
  logError(`Input cancelled for variable "${variableName}".`);
  process.exit(1);
}

export async function resolveAskValue(variableName: string, valueFrom: string): Promise<string> {
  const tokens = tokenizeAskArgs(valueFrom.trim());
  const rawCommand = tokens[1];
  const rest = tokens.slice(2);
  const command = ASK_ALIASES[rawCommand] ?? rawCommand;
  if (!["select", "multiselect", "confirm", "text", "password"].includes(command)) {
    logError(
      `Unknown "ask" command "${rawCommand ?? ""}" (variable "${variableName}"). ` +
        `Supported: select, multiselect, confirm, text, password.`,
    );
    process.exit(1);
  }
  requireTTY(command);
  switch (command) {
    case "select": {
      if (rest.length === 0) {
        logError(`"ask select" needs at least one option (variable "${variableName}").`);
        process.exit(1);
      }
      const value = await p.select({
        message: `Select ${variableName}`,
        options: rest.map((choice) => ({ value: choice, label: choice })),
      });
      if (p.isCancel(value)) handleAskCancel(variableName);
      return String(value);
    }
    case "multiselect": {
      if (rest.length === 0) {
        logError(`"ask multiselect" needs at least one option (variable "${variableName}").`);
        process.exit(1);
      }
      const values = await p.multiselect({
        message: `Select ${variableName}`,
        options: rest.map((choice) => ({ value: choice, label: choice })),
      });
      if (p.isCancel(values)) handleAskCancel(variableName);
      // One selection per line, mirroring `gum choose --no-limit` output.
      return (values as string[]).join("\n");
    }
    case "confirm": {
      const value = await p.confirm({
        message: rest.join(" ") || `Confirm ${variableName}?`,
      });
      if (p.isCancel(value)) handleAskCancel(variableName);
      return value ? "true" : "false";
    }
    case "text": {
      const value = await p.text({
        message: variableName,
        placeholder: rest.join(" ") || undefined,
      });
      if (p.isCancel(value)) handleAskCancel(variableName);
      return String(value ?? "").trim();
    }
    case "password": {
      const value = await p.password({
        message: variableName,
      });
      if (p.isCancel(value)) handleAskCancel(variableName);
      return String(value ?? "").trim();
    }
    default: {
      // Unreachable: unknown commands are rejected before the TTY check above.
      logError(`Unknown "ask" command (variable "${variableName}").`);
      process.exit(1);
    }
  }
}

export function parseSets(entries: string[] | undefined): Record<string, string> {
  const sets: Record<string, string> = {};
  for (const entry of entries ?? []) {
    const eq = entry.indexOf("=");
    if (eq <= 0) {
      logError(`Invalid --set "${entry}". Expected format: --set key=value.`);
      process.exit(1);
    }
    sets[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return sets;
}

export function parseDotenv(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice(7).trimStart() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue; // lenient: ignore junk lines
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = body.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value
          .replace(/\\n/g, "\n")
          .replace(/\\t/g, "\t")
          .replace(/\\r/g, "\r")
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\");
      }
    }
    vars[key] = value;
  }
  return vars;
}

export async function resolveValueFrom(
  variable: Variable,
  cliSets: Record<string, string>,
  params: Params = {},
): Promise<string> {
  // CLI --set wins over everything declared in the file.
  if (cliSets[variable.name] !== undefined) return cliSets[variable.name];
  if (variable.value !== undefined) return variable.value;
  if (variable.valueFrom === undefined) {
    if (variable.default !== undefined) return variable.default;
    throw new Error(`Variable "${variable.name}" needs 'value', 'valueFrom' or 'default'.`);
  }
  const source = variable.valueFrom;
  if (isAskCommand(source)) return resolveAskValue(variable.name, source);
  // `valueFrom: "arg"` (key = variable name) or `"arg:key"` (explicit key).
  const argMatch = /^arg(?::(.+))?$/.exec(source.trim());
  if (argMatch) {
    const key = argMatch[1] ?? variable.name;
    if (cliSets[key] !== undefined) return cliSets[key];
    if (variable.default !== undefined) return variable.default;
    throw new Error(`Variable "${variable.name}" requires --set ${key}=<value> (or a 'default:').`);
  }
  // `valueFrom: "env:NAME"` reads the environment (CI secrets friendly).
  const envMatch = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(source.trim());
  if (envMatch) {
    const value = process.env[envMatch[1]];
    if (value !== undefined) return value;
    if (variable.default !== undefined) return variable.default;
    throw new Error(
      `Variable "${variable.name}" requires env ${envMatch[1]} to be set (or a 'default:').`,
    );
  }
  // `valueFrom: "dotenv:<path>:<KEY>"` reads KEY from a dotenv file.
  // The path can reference variables resolved so far.
  const dotenvMatch = /^dotenv:(.+):([A-Za-z_][A-Za-z0-9_]*)$/.exec(source.trim());
  if (dotenvMatch) {
    return readKeyFromDotenv(variable, substituteVariables(dotenvMatch[1], params), dotenvMatch[2]);
  }
  // `valueFrom: "file:<path>"` reads the whole file (trimmed).
  const fileMatch = /^file:(.+)$/.exec(source.trim());
  if (fileMatch) {
    return readWholeFile(variable, substituteVariables(fileMatch[1], params));
  }
  // Future interpreters (e.g. `valueFrom: "https://..."` via API) plug in here.
  const result = await runShell(source);
  return result.trim();
}

async function readKeyFromDotenv(variable: Variable, filePath: string, key: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(filePath, "utf-8");
  } catch {
    if (variable.default !== undefined) return variable.default;
    throw new Error(`Dotenv file not found: "${filePath}".`);
  }
  const vars = parseDotenv(text);
  if (vars[key] === undefined) {
    if (variable.default !== undefined) return variable.default;
    throw new Error(`Key "${key}" not found in "${filePath}".`);
  }
  return vars[key];
}

async function readWholeFile(variable: Variable, filePath: string): Promise<string> {
  try {
    return (await readFile(filePath, "utf-8")).trim();
  } catch {
    if (variable.default !== undefined) return variable.default;
    throw new Error(`File not found: "${filePath}".`);
  }
}
