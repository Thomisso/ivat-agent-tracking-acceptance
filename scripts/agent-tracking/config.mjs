import fs from "node:fs";
import path from "node:path";
import { TrackerError } from "./github.mjs";
import { activities, statuses, textFields, registryMarker, initialState, renderRegistry, readRegistry } from "./state.mjs";

export function configPath(options = {}) { return path.resolve(options.config ?? ".github/agent-tracking.json"); }

export function loadConfig(options = {}) {
  const file = configPath(options);
  if (!fs.existsSync(file)) throw new TrackerError("configuration_missing");
  let config;
  try { config = JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw new TrackerError("configuration_invalid"); }
  if (config.schemaVersion !== 1 || !/^[\w.-]+\/[\w.-]+$/.test(config.repository) || !Number.isInteger(config.registryIssue) || config.registryIssue <= 0 || !config.project?.id || !Number.isInteger(config.project.number) || config.project.number <= 0 || !config.fields || !/^[\w.-]+\.ya?ml$/.test(config.workflow ?? "") || !config.codeRef) throw new TrackerError("configuration_invalid");
  const definitions = { status: statuses, activity: activities, ...Object.fromEntries(Object.keys(textFields).map(key => [key, null])) };
  for (const [key, options] of Object.entries(definitions)) {
    const field = config.fields[key];
    if (!field?.id || !field.name || (options && Object.keys(options).some(option => !field.options?.[option]))) throw new TrackerError("configuration_invalid");
  }
  return config;
}

export function validateConfig(github, config) {
  const repository = github.request(`repos/${config.repository}`);
  if (repository.full_name.toLowerCase() !== config.repository.toLowerCase() || repository.owner.login.toLowerCase() !== config.owner.toLowerCase() || repository.owner.type !== config.ownerType) throw new TrackerError("repository_mismatch");
  const project = github.project(config.owner, config.project.number, config.ownerType);
  if (!project || project.id !== config.project.id) throw new TrackerError("project_mismatch");
  const result = github.fields(project.id);
  if (result.pageInfo.hasNextPage) throw new TrackerError("project_fields_exceed_limit");
  for (const field of Object.values(config.fields)) {
    const actual = result.nodes.find(item => item.id === field.id && item.name === field.name);
    if (!actual || actual.dataType !== (field.options ? "SINGLE_SELECT" : "TEXT")) throw new TrackerError("field_configuration_mismatch");
    for (const [key, id] of Object.entries(field.options ?? {})) {
      const name = field.name === "Status" ? statuses[key] : activities[key];
      if (!actual.options?.some(option => option.id === id && option.name === name)) throw new TrackerError("field_configuration_mismatch");
    }
  }
  readRegistry(github, config);
  const workflows = github.workflows(project.id);
  if (workflows.pageInfo.hasNextPage) throw new TrackerError("project_workflows_exceed_limit");
  if (workflows.nodes.some(workflow => workflow.enabled)) throw new TrackerError("native_workflows_enabled");
  return { repository, project };
}

export function setup(github, options) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(options.repo ?? "") || !/^[\w.-]+$/.test(options.owner ?? "")) throw new TrackerError("setup_arguments_invalid");
  const repository = github.request(`repos/${options.repo}`);
  const ownerType = repository.owner.type;
  if (repository.owner.login.toLowerCase() !== options.owner.toLowerCase()) throw new TrackerError("project_owner_mismatch");
  let number = Number(options["project-number"]);
  if (!Number.isInteger(number) || number <= 0) throw new TrackerError("project_selection_required");
  const project = github.project(options.owner, number, ownerType);
  if (!project) throw new TrackerError("project_missing");
  const workflows = github.workflows(project.id);
  if (workflows.pageInfo.hasNextPage) throw new TrackerError("project_workflows_exceed_limit");
  for (const workflow of workflows.nodes.filter(workflow => workflow.enabled)) {
    if (!options["disable-native-workflows"]) throw new TrackerError("native_workflows_enabled");
    github.graph(`mutation TrackerDeleteWorkflow($input:DeleteProjectV2WorkflowInput!){deleteProjectV2Workflow(input:$input){deletedWorkflowId}}`, { input: { workflowId: workflow.id } });
  }
  const current = github.fields(project.id);
  if (current.pageInfo.hasNextPage) throw new TrackerError("project_fields_exceed_limit");
  const fields = {};
  const definitions = { status: { name: "Status", options: statuses }, activity: { name: "Activity", options: activities }, ...Object.fromEntries(Object.entries(textFields).map(([key, name]) => [key, { name }])) };
  for (const [key, definition] of Object.entries(definitions)) {
    let field = current.nodes.find(item => item.name === definition.name);
    const dataType = definition.options ? "SINGLE_SELECT" : "TEXT";
    if (field && field.dataType !== dataType) throw new TrackerError("field_configuration_mismatch");
    const desiredOptions = definition.options && Object.values(definition.options).map(name => ({ name, color: "GRAY", description: "" }));
    if (!field) {
      const input = { projectId: project.id, name: definition.name, dataType, ...(desiredOptions ? { singleSelectOptions: desiredOptions } : {}) };
      field = github.graph(`mutation TrackerCreateField($input:CreateProjectV2FieldInput!){ createProjectV2Field(input:$input){ projectV2Field{ ... on ProjectV2Field{id name dataType} ... on ProjectV2SingleSelectField{id name dataType options{id name}} } } }`, { input }).createProjectV2Field.projectV2Field;
    } else if (desiredOptions?.some(option => !field.options?.some(existing => existing.name === option.name))) {
      const options = [...field.options.map(option => ({ id: option.id, name: option.name, color: option.color ?? "GRAY", description: option.description ?? "" })), ...desiredOptions.filter(option => !field.options.some(existing => existing.name === option.name))];
      field = github.graph(`mutation TrackerUpdateField($input:UpdateProjectV2FieldInput!){ updateProjectV2Field(input:$input){ projectV2Field{ ... on ProjectV2SingleSelectField{id name dataType options{id name}} } } }`, { input: { fieldId: field.id, singleSelectOptions: options } }).updateProjectV2Field.projectV2Field;
    }
    fields[key] = { id: field.id, name: definition.name, ...(definition.options ? { options: Object.fromEntries(Object.entries(definition.options).map(([optionKey, name]) => [optionKey, field.options.find(option => option.name === name).id])) } : {}) };
  }
  const registryIssue = Number(options["registry-issue"]);
  if (!Number.isInteger(registryIssue) || registryIssue <= 0) throw new TrackerError("registry_selection_required");
  const config = { schemaVersion: 1, repository: repository.full_name, owner: options.owner, ownerType, project: { ...project, number }, registryIssue, workflow: options.workflow ?? "agent-tracking.yml", codeRef: options.ref ?? repository.default_branch, fields };
  const matches = github.pages(`repos/${config.repository}/issues/${registryIssue}/comments`).filter(comment => comment.body.startsWith(registryMarker));
  if (matches.length > 1) throw new TrackerError("registry_ambiguous");
  if (!matches.length) github.request(`repos/${config.repository}/issues/${registryIssue}/comments`, { method: "POST", body: { body: renderRegistry(initialState()) } });
  const file = configPath(options);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  validateConfig(github, config);
  return { ok: true, config: file, project: project.url };
}
