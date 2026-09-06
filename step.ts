import { $, Glob } from "bun";
import { access, rm, mkdir, stat, copyFile } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { logWarning, logSuccess, logInfo } from "./log.ts";

export interface Step {
  bash?: string;
  // Azure-style checkout: `checkout: <git-url>` clones the repository.
  // `checkout: none` is a no-op (homologated with Azure Pipelines).
  checkout?: string;
  // Where to put the repository. Defaults to `./<repo-name>` derived from the URL.
  path?: string;
  // If true and the path exists, remove it and clone fresh.
  // (Azure runs `git clean -ffdx` + `git reset --hard HEAD`; locally a fresh
  // clone is the equivalent.)
  clean?: boolean;
  // PRE extension (Azure resolves the version differently): branch to clone.
  branch?: string;
  // Homologated with Azure `steps.checkout.fetchDepth`: `fetchDepth: 1`
  // downloads only the current version (shallow clone). `0`/unset = full history.
  fetchDepth?: number;
  displayName?: string;
  parallel?: boolean;
  continueOnError?: boolean;
  // Homologated with Azure `steps.*.condition` (v1 subset, see evaluateCondition).
  condition?: string;
  // File actions (homologated with Azure CopyFiles@2 / DeleteFiles@1):
  // `copy: <file-or-dir>` + `target: <dir>` copies (see runCopyStep).
  copy?: string;
  // Destination directory for `copy` (required with it). `contents` limits
  // which files are copied (glob(s) relative to the source dir, `!` negates).
  target?: string;
  contents?: string | string[];
  // `clean: true` removes the target before copying (shared with checkout).
  // `overwrite: false` keeps existing files (default true).
  overwrite?: boolean;
  // `delete: <path|dir|glob>` removes files (glob relative to cwd).
  delete?: string;
}

export interface Params {
  [key: string]: string;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// Bun.$ escapes interpolated strings by default, so dynamic shell
// sentences from YAML must go through `{ raw: command }`
// (equivalent to dax's $.raw``).
export function runShell(command: string) {
  return $`${{ raw: command }}`.text();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function substituteVariables(command: string, params: Params): string {
  // Ordenar por longitud descendente para evitar solapamientos (name2 antes que name)
  // Homologado Azure Pipelines: acepta tanto ${VAR} (PRE) como $(VAR) (Azure).
  const keys = Object.keys(params).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    const escaped = escapeRegExp(key);
    command = command
      .replace(new RegExp(`\\$\\{${escaped}\\}`, "g"), params[key])
      .replace(new RegExp(`\\$\\(${escaped}\\)`, "g"), params[key]);
  }
  return command;
}

export function deriveRepoDir(url: string): string {
  const segment = url.replace(/\/+$/, "").split("/").pop() ?? "";
  return segment.replace(/\.git$/, "") || "cloned_repo";
}

export async function runCopyStep(step: Step, params: Params): Promise<void> {
  if (!step.target) throw new Error("'copy' step requires 'target'.");
  const source = substituteVariables(step.copy as string, params);
  const target = substituteVariables(step.target, params);
  const st = await stat(source).catch(() => null);
  if (!st) throw new Error(`Copy source not found: "${source}".`);
  if (step.clean) {
    logWarning(`=> rm -rf ${target} (clean)`);
    await rm(target, { recursive: true, force: true });
  }
  await mkdir(target, { recursive: true });
  let copied = 0;
  let skipped = 0;
  const put = async (from: string, to: string) => {
    if (step.overwrite === false && (await exists(to))) {
      skipped++;
      return;
    }
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
    copied++;
  };
  if (st.isFile()) {
    await put(source, join(target, basename(source)));
  } else if (!st.isDirectory()) {
    throw new Error(`Copy source is neither a file nor a directory: "${source}".`);
  } else {
    const rawPatterns =
      step.contents === undefined ? ["**/*"] : Array.isArray(step.contents) ? step.contents : [step.contents];
    const includes: string[] = [];
    const excludes: Glob[] = [];
    for (const raw of rawPatterns) {
      const pattern = substituteVariables(raw, params);
      if (pattern.startsWith("!")) excludes.push(new Glob(pattern.slice(1)));
      else includes.push(pattern);
    }
    for (const pattern of includes.length ? includes : ["**/*"]) {
      const glob = new Glob(pattern);
      for await (const rel of glob.scan({ cwd: source, dot: true })) {
        if (excludes.some((g) => g.match(rel))) continue;
        const from = join(source, rel);
        const fst = await stat(from).catch(() => null);
        if (!fst || !fst.isFile()) continue;
        await put(from, join(target, rel));
      }
    }
  }
  logSuccess(
    ` √ copied ${copied} file(s)${skipped ? `, skipped ${skipped} (overwrite: false)` : ""} → ${target}`,
  );
}

export async function runDeleteStep(step: Step, params: Params): Promise<void> {
  const raw = substituteVariables(step.delete as string, params);
  if (await exists(raw)) {
    logWarning(`=> rm -rf ${raw}`);
    await rm(raw, { recursive: true, force: true });
    logSuccess(` √ deleted ${raw}`);
    return;
  }
  // Otherwise treat it as a glob relative to the working directory.
  const glob = new Glob(raw.replace(/^\.\//, ""));
  let count = 0;
  for await (const rel of glob.scan({ cwd: ".", dot: true })) {
    await rm(rel, { recursive: true, force: true });
    count++;
  }
  if (count === 0) logWarning(`No matches for "${raw}" (nothing deleted).`);
  else logSuccess(` √ deleted ${count} path(s) matching "${raw}"`);
}

// --- Azure-style `condition:` (v1 cheap subset) ---
// Supported: always(), succeeded(), failed(), succeededOrFailed(),
// not(x), and(...), or(...), eq(a, b), ne(a, b),
// contains(haystack, needle), startsWith(s, prefix), endsWith(s, suffix).
// Variable references (`${V}` / `$(V)`, `variables['V']`, `variables.V`)
// are substituted before evaluation.
// NOTE (v1 limitation): with the current fail-fast semantics, a step only
// runs when nothing failed yet, so succeeded() is always true and failed()
// always false when evaluated. Dynamic failure tracking is a v2 feature.
const CONDITION_FUNCTIONS = [
  "always",
  "succeeded",
  "failed",
  "succeededOrFailed",
  "not",
  "and",
  "or",
  "eq",
  "ne",
  "contains",
  "startsWith",
  "endsWith",
];

function quoteLiteral(value: string): string {
  return JSON.stringify(value);
}

type ConditionValue = string | boolean | number;

class ConditionParser {
  private pos = 0;
  constructor(private readonly input: string) {}

  evaluate(): ConditionValue {
    const value = this.parseValue();
    this.skipWs();
    if (this.pos < this.input.length) {
      throw new Error(`Unexpected "${this.input[this.pos]}" in condition.`);
    }
    return value;
  }

  private skipWs(): void {
    while (this.pos < this.input.length && /\s/.test(this.input[this.pos])) this.pos++;
  }

  private parseValue(): ConditionValue {
    this.skipWs();
    const ch = this.input[this.pos];
    if (ch === "'" || ch === '"') return this.parseString();
    if (ch === undefined) throw new Error("Unexpected end of condition.");
    if (/[0-9-]/.test(ch)) return this.parseNumber();
    if (/[A-Za-z_]/.test(ch)) return this.parseFunctionOrLiteral();
    throw new Error(`Unexpected "${ch}" in condition.`);
  }

  private parseString(): string {
    const quote = this.input[this.pos++];
    let out = "";
    while (this.pos < this.input.length) {
      const ch = this.input[this.pos++];
      if (ch === "\\" && this.pos < this.input.length) {
        out += this.input[this.pos++];
      } else if (ch === quote) {
        return out;
      } else {
        out += ch;
      }
    }
    throw new Error("Unterminated string in condition.");
  }

  private parseNumber(): number {
    const m = /^-?\d+(\.\d+)?/.exec(this.input.slice(this.pos));
    if (!m) throw new Error("Invalid number in condition.");
    this.pos += m[0].length;
    return Number(m[0]);
  }

  private parseFunctionOrLiteral(): ConditionValue {
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.input.slice(this.pos));
    const name = m![0];
    this.pos += name.length;
    this.skipWs();
    if (this.input[this.pos] !== "(") {
      if (name === "true") return true;
      if (name === "false") return false;
      throw new Error(`Unknown name "${name}" in condition (did you mean a function?).`);
    }
    this.pos++; // (
    const args: ConditionValue[] = [];
    this.skipWs();
    if (this.input[this.pos] !== ")") {
      for (;;) {
        args.push(this.parseValue());
        this.skipWs();
        if (this.input[this.pos] === ",") {
          this.pos++;
          continue;
        }
        break;
      }
    }
    this.skipWs();
    if (this.input[this.pos] !== ")") throw new Error(`Expected ")" in condition.`);
    this.pos++;
    return applyConditionFunction(name, args);
  }
}

function asBoolean(value: ConditionValue, fn: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`"${fn}" expects true/false arguments.`);
  }
  return value;
}

function applyConditionFunction(name: string, args: ConditionValue[]): ConditionValue {
  switch (name) {
    case "always":
    case "succeeded":
    case "succeededOrFailed":
      if (args.length !== 0) throw new Error(`"${name}()" takes no arguments.`);
      return true;
    case "failed":
      if (args.length !== 0) throw new Error(`"failed()" takes no arguments.`);
      return false; // v1 limitation, see note above.
    case "not":
      if (args.length !== 1) throw new Error(`"not()" takes exactly 1 argument.`);
      return !asBoolean(args[0], "not");
    case "and":
      return args.every((a) => asBoolean(a, "and"));
    case "or":
      return args.some((a) => asBoolean(a, "or"));
    case "eq":
    case "ne": {
      if (args.length !== 2) throw new Error(`"${name}()" takes exactly 2 arguments.`);
      const same = String(args[0]) === String(args[1]);
      return name === "eq" ? same : !same;
    }
    case "contains":
    case "startsWith":
    case "endsWith": {
      if (args.length !== 2) throw new Error(`"${name}()" takes exactly 2 arguments.`);
      const [haystack, needle] = [String(args[0]), String(args[1])];
      if (name === "contains") return haystack.includes(needle);
      if (name === "startsWith") return haystack.startsWith(needle);
      return haystack.endsWith(needle);
    }
    default:
      throw new Error(
        `Unknown condition function "${name}". Supported: ${CONDITION_FUNCTIONS.join(", ")}.`,
      );
  }
}

export function evaluateCondition(condition: string, params: Params): boolean {
  if (!condition.trim()) throw new Error("Empty condition.");
  // Azure `variables['X']` / `variables["X"]` / `variables.X` → literal value.
  let expr = condition
    .replace(/variables\[['"]([^'"]+)['"]\]/g, (_m, name) => quoteLiteral(params[name] ?? ""))
    .replace(/variables\.([A-Za-z_][A-Za-z0-9_.]*)/g, (_m, name) => quoteLiteral(params[name] ?? ""));
  // PRE/Azure macro syntax.
  expr = substituteVariables(expr, params);
  // Azure semantics: unknown macros expand to empty string.
  expr = expr.replace(/\$\{[^}]+\}/g, "").replace(/\$\([^)]+\)/g, "");
  const value = new ConditionParser(expr).evaluate();
  if (typeof value !== "boolean") {
    throw new Error(`Condition must evaluate to true/false (got "${condition}").`);
  }
  return value;
}

export async function runCheckoutStep(step: Step, params: Params): Promise<void> {
  const repo = substituteVariables(step.checkout as string, params);
  if (repo === "none") {
    logInfo("Checkout none: skipping.");
    return;
  }
  const target = step.path
    ? substituteVariables(step.path, params)
    : `./${deriveRepoDir(repo)}`;
  const branch = step.branch ? substituteVariables(step.branch, params) : undefined;
  let depthFlag = "";
  if (step.fetchDepth !== undefined) {
    if (!Number.isInteger(step.fetchDepth) || (step.fetchDepth as number) < 0) {
      throw new Error(`"fetchDepth" must be a non-negative integer (got "${step.fetchDepth}").`);
    }
    // Azure semantics: 0 (or unset) = full history, n >= 1 = shallow.
    if ((step.fetchDepth as number) > 0) depthFlag = `--depth ${step.fetchDepth} `;
  }

  if (await exists(target)) {
    if (step.clean) {
      logWarning(`=> rm -rf ${target} (clean)`);
      await runShell(`rm -rf ${target}`);
    } else {
      console.log(`Repository already exists at ${target}. Skipping clone.`);
      return;
    }
  }
  const branchFlag = branch ? `--branch ${branch} ` : "";
  logWarning(`=> git clone ${branchFlag}${depthFlag}${repo} ${target}`);
  const result = await runShell(`git clone ${branchFlag}${depthFlag}${repo} ${target}`);
  const output = result.trimEnd();
  if (output) logSuccess(` √ ${output}`);
  else logSuccess(" √ cloned successfully");
}
