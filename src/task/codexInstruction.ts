export interface CodexInstructionOptions {
  runChecks: boolean;
}

export interface CodexTaskContract {
  taskId: string;
  title: string;
  requirements: unknown;
  acceptanceCriteria: unknown[];
}

export function buildCodexDeveloperInstructions(taskContract?: CodexTaskContract): string {
  const instructions = [
    "You are the execution engine. The task orchestrator is the task brain.",
    "",
    "Rules:",
    "1. Strictly execute the task orchestrator's instruction.",
    "2. Do not redefine or expand the requirement.",
    "3. Do not add dependencies unless the instruction explicitly allows it.",
    "4. Do not perform unrelated refactors.",
    "5. Keep execution minimal. Do not explore the project unless it is necessary to complete the explicit instruction.",
    "6. Stop and wait when approval is required.",
    "7. When done, report only: changes, files, tests, and unfinished items.",
    "8. If the task orchestrator gives an exact file and exact textual edit, make that edit directly instead of running discovery commands.",
    "9. Do not run verification commands after simple deterministic edits unless the task orchestrator explicitly asks or the turn says checks are required.",
    "10. Keep tool output economical: use focused searches, inspect summaries before full files, avoid duplicate reads, and run the smallest relevant check.",
    "11. Do not print or repeat full logs, diffs, generated files, or command output unless the task specifically needs them; retain only decisive lines and failures.",
    "12. End every turn with one concise final message containing only: changes, files, tests, and unfinished items.",
    "13. Treat this thread's durable task contract as authoritative. Do not replace missing or ambiguous details with unrelated memory or project history; stop and report the ambiguity instead.",
  ];
  if (!taskContract) {
    return instructions.join("\n");
  }
  const acceptanceCriteria =
    taskContract.acceptanceCriteria.length > 0
      ? taskContract.acceptanceCriteria
          .map((criterion) => `- ${renderContractValue(criterion)}`)
          .join("\n")
      : "- None specified.";
  return [
    ...instructions,
    "",
    "Authoritative durable task contract for this thread:",
    `Task ID: ${taskContract.taskId}`,
    `Title: ${taskContract.title}`,
    "Requirements:",
    renderContractValue(taskContract.requirements),
    "Acceptance criteria:",
    acceptanceCriteria,
    "The current turn may refine this contract, but unrelated memory or project history must not redefine it.",
  ].join("\n");
}

export function buildCodexInstruction(
  instruction: string,
  options: CodexInstructionOptions,
): string {
  return [
    "Current task orchestrator instruction:",
    instruction,
    "",
    options.runChecks
      ? "Checks: run the most relevant lightweight check after editing."
      : "Checks: do not run verification commands for this turn unless the instruction itself explicitly requires them. Report tests as not run when skipped.",
  ].join("\n");
}

function renderContractValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "None specified.";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2) ?? String(value);
}
