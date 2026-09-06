#!/usr/bin/env bun
import { $ } from "bun";
import { access, readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { load as parseYaml } from "js-yaml";

interface Variable {
  name: string;
  value?: string;
  valueFrom?: string;
}

interface Step {
  bash: string;
  displayName?: string;
  parallel?: boolean;
  continueOnError?: boolean;
}

interface Config {
  variables: Variable[];
  steps: Step[];
}

interface Params {
  [key: string]: string;
}

interface ConfigResult {
  params: Params;
  steps: Step[];
  continueOnError: boolean;
}

const colors = {
  red: "\x1b[38;2;255;20;60m", // errors
  yellow: "\x1b[33m", // warnings
  green: "\x1b[32m", // success
  blue: "\x1b[38;2;0;157;255m", // info
  reset: "\x1b[0m",
};

function logError(message: string) {
  console.error(`${colors.red}${message}${colors.reset}`);
}

function logWarning(message: string) {
  console.warn(`${colors.yellow}${message}${colors.reset}`);
}

function logSuccess(message: string) {
  console.log(`${colors.green}${message}${colors.reset}`);
}

function logInfo(message: string) {
  console.log(`${colors.blue}${message}${colors.reset}`);
}

async function exists(path: string): Promise<boolean> {
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
function runShell(command: string) {
  return $`${{ raw: command }}`.text();
}

let hasValueFrom = false;

async function loadParameters(): Promise<ConfigResult> {
  let configPath: string | undefined;

  // 1. Check if config is provided as an argument
  const { values: args } = parseArgs({
    args: process.argv.slice(2),
    options: {
      config: { type: "string" },
      "continue-on-error": { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const continueOnError = !!args["continue-on-error"];
  if (args.config) {
    configPath = args.config;
    if (await exists(configPath)) {
      console.log(`Using configuration from argument: ${configPath}`);
    } else {
      logError(`Error: Configuration file specified in arguments not found: ${configPath}`);
      process.exit(1);
    }
  }

  // 2. Check ./_pre.yml if no argument provided
  if (!configPath && (await exists("./_pre.yml"))) {
    configPath = "./_pre.yml";
    console.log("Using configuration from ./_pre.yml");
  }

  // 3. Check ./pre/_pre.yml if previous locations not found
  if (!configPath && (await exists("./pre/_pre.yml"))) {
    configPath = "./pre/_pre.yml";
    console.log("Using configuration from ./pre/_pre.yml");
  }

  // 4. Error if no configuration file found
  if (!configPath) {
    logWarning("Error: No configuration file found. Please provide one of the following:");
    logWarning("- Use --config argument to specify the configuration file");
    logWarning("- Place _pre.yml in the current directory");
    logWarning("- Place _pre.yml in the ./pre directory");
    process.exit(1);
  }

  const configText = await readFile(configPath as string, "utf-8");
  const config = parseYaml(configText) as Config;
  if (!config.variables || !Array.isArray(config.variables)) {
    logError("El archivo YAML debe contener una lista 'variables'.");
    process.exit(1);
  }
  if (!config.steps || !Array.isArray(config.steps)) {
    logError("El archivo YAML debe contener una lista 'steps'.");
    process.exit(1);
  }

  const params: Params = {};
  await Promise.all(
    config.variables?.map(async (variable: Variable) => {
      if (variable.value !== undefined) {
        params[variable.name] = variable.value;
      } else if (variable.valueFrom !== undefined) {
        // valueRead
        const result = await runShell(variable.valueFrom);
        params[variable.name] = result.trim();
        hasValueFrom = true;
      }
    }) || [],
  );

  return { params, steps: config.steps, continueOnError };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function substituteVariables(command: string, params: Params): string {
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

async function executeSteps(steps: Step[], params: Params, continueOnError: boolean) {
  // Agrupar pasos paralelos y secuenciales
  let i = 0;
  while (i < steps.length) {
    if (steps[i].parallel) {
      // Ejecutar todos los pasos consecutivos con parallel: true
      const parallelGroup = [];
      while (i < steps.length && steps[i].parallel) {
        parallelGroup.push(steps[i]);
        i++;
      }
      await Promise.all(parallelGroup.map(async (step) => {
        await runStep(step, params, continueOnError);
      }));
    } else {
      await runStep(steps[i], params, continueOnError);
      i++;
    }
  }
  logSuccess(":: [ Prepared sentences completed successfully ] ::");
}

async function runStep(step: Step, params: Params, continueOnError: boolean) {
  if (step.displayName) {
    logInfo(`\n:: [ ${step.displayName} ] ::`);
  }
  const command = substituteVariables(step.bash, params);
  // Homologado Azure Pipelines: continueOnError por step, con fallback al flag global.
  const effectiveContinueOnError = step.continueOnError ?? continueOnError;
  try {
    logWarning(`=> ${command}`);
    const result = await runShell(command);
    logSuccess(` √ ${result.trimEnd()}`);
  } catch (error: unknown) {
    logError(`\n * Error executing: ${command}\n`);
    if (!effectiveContinueOnError) {
      process.exit(1);
    }
  }
}

async function main() {
  const { params, steps, continueOnError } = await loadParameters();
  console.log(`\n=> Loaded parameters:`, params);
  await executeSteps(steps, params, continueOnError);
}

main();
