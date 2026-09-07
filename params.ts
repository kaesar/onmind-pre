import * as p from "@clack/prompts";
import { logError } from "./trace.ts";

// Top-level `parameters:` block: the blueprint's input contract
// (homologated with Azure Pipelines runtime parameters, which render as
// the "Run pipeline" form). Unlike `valueFrom: arg` (a per-variable read
// mechanism), parameters declare types, allowed values and required-ness,
// and are validated BEFORE anything runs.
export interface Parameter {
  name: string;
  type?: "string" | "number" | "boolean";
  default?: string | number | boolean;
  values?: Array<string | number | boolean>;
  required?: boolean;
  displayName?: string;
}

const TRUE_VALUES = new Set(["true", "1", "yes", "y"]);
const FALSE_VALUES = new Set(["false", "0", "no", "n"]);

function coerceType(param: Parameter, raw: string): string {
  const type = param.type ?? "string";
  if (type === "number") {
    if (raw.trim() === "" || Number.isNaN(Number(raw))) {
      throw new Error(`must be a number (got "${raw}")`);
    }
    return String(Number(raw));
  }
  if (type === "boolean") {
    const v = raw.trim().toLowerCase();
    if (TRUE_VALUES.has(v)) return "true";
    if (FALSE_VALUES.has(v)) return "false";
    throw new Error(`must be true/false (got "${raw}")`);
  }
  if (type !== "string") {
    throw new Error(`unsupported type "${param.type}" (supported: string, number, boolean)`);
  }
  return raw;
}

function checkValue(param: Parameter, raw: string): string {
  const value = coerceType(param, raw);
  if (param.values !== undefined) {
    const allowed = param.values.map((v) => coerceType({ ...param, values: undefined }, String(v)));
    if (!allowed.includes(value)) {
      throw new Error(`must be one of [${allowed.join(", ")}] (got "${raw}")`);
    }
  }
  return value;
}

function checkDeclaration(param: Parameter): void {
  if (!param.name) throw new Error("Parameter without 'name'.");
  coerceType(param, "0"); // validates the type itself
  if (param.values !== undefined) {
    if (!Array.isArray(param.values) || param.values.length === 0) {
      throw new Error(`Parameter "${param.name}" needs a non-empty 'values' list.`);
    }
  }
  if (param.default !== undefined) {
    try {
      checkValue(param, String(param.default));
    } catch (error: unknown) {
      throw new Error(`Invalid default for parameter "${param.name}": ${(error as Error).message}`);
    }
  }
}

function cancelParameter(name: string): never {
  logError(`Input cancelled for parameter "${name}".`);
  process.exit(1);
}

async function promptForParameter(param: Parameter): Promise<string> {
  const label = param.displayName ?? param.name;
  if (param.values !== undefined && param.values.length > 0) {
    const options = param.values.map((v) => String(v));
    const value = await p.select({
      message: label,
      options: options.map((o) => ({ value: o, label: o })),
    });
    if (p.isCancel(value)) cancelParameter(param.name);
    return checkValue(param, String(value));
  }
  if ((param.type ?? "string") === "boolean") {
    const value = await p.confirm({ message: label });
    if (p.isCancel(value)) cancelParameter(param.name);
    return value ? "true" : "false";
  }
  const value = await p.text({
    message: label,
    validate: (v) => {
      if (!String(v ?? "").trim()) return "Required.";
      if ((param.type ?? "string") === "number" && Number.isNaN(Number(v))) {
        return "Must be a number.";
      }
      return undefined;
    },
  });
  if (p.isCancel(value)) cancelParameter(param.name);
  return checkValue(param, String(value ?? ""));
}

export async function resolveParameters(
  declared: Parameter[] | undefined,
  cliSets: Record<string, string>,
): Promise<Record<string, string>> {
  const list = declared ?? [];
  const seen = new Set<string>();
  for (const param of list) {
    checkDeclaration(param);
    if (seen.has(param.name)) throw new Error(`Duplicate parameter "${param.name}".`);
    seen.add(param.name);
  }
  const resolved: Record<string, string> = {};
  const problems: string[] = [];
  const interactive = !!process.stdin.isTTY;
  for (const param of list) {
    const supplied = cliSets[param.name];
    if (supplied !== undefined) {
      try {
        resolved[param.name] = checkValue(param, supplied);
      } catch (error: unknown) {
        problems.push(`"${param.name}": ${(error as Error).message}`);
      }
      continue;
    }
    if (param.default !== undefined) {
      resolved[param.name] = checkValue(param, String(param.default));
      continue;
    }
    if ((param.required ?? true) === false) {
      resolved[param.name] = "";
      continue;
    }
    if (!interactive) {
      problems.push(`"${param.name}": required but not provided (use --set ${param.name}=... or run in a terminal)`);
      continue;
    }
    resolved[param.name] = await promptForParameter(param);
  }
  if (problems.length > 0) {
    logError(`Invalid parameters:\n${problems.map((m) => ` - ${m}`).join("\n")}`);
    process.exit(1);
  }
  return resolved;
}
