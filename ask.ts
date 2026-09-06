import * as p from "@clack/prompts";
import { logError } from "./log.ts";

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
