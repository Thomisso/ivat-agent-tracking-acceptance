import { TrackerError } from "./github.mjs";

const viewFields = `id name layout filter configuration{visibleFields(first:100){nodes{... on ProjectV2Field{id} ... on ProjectV2SingleSelectField{id}}}} groupByFields(first:10){nodes{... on ProjectV2Field{id} ... on ProjectV2SingleSelectField{id}}}`;

function readViews(github, config) {
  const connection = github.graph(`query TrackerViews($id:ID!){node(id:$id){... on ProjectV2{views(first:100){nodes{${viewFields}} pageInfo{hasNextPage}}}}}`, { id: config.project.id }).node.views;
  if (connection.pageInfo.hasNextPage) throw new TrackerError("project_views_exceed_limit");
  return connection.nodes;
}

export function reconcileViews(github, config, state) {
  const fields = github.fields(config.project.id);
  if (fields.pageInfo.hasNextPage) throw new TrackerError("project_fields_exceed_limit");
  const parent = fields.nodes.find(field => field.dataType === "PARENT_ISSUE");
  if (!parent) throw new TrackerError("native_parent_field_missing");
  const visibleFieldIds = [...new Set([...fields.nodes.filter(field => ["TITLE", "ASSIGNEES", "PARENT_ISSUE"].includes(field.dataType)).map(field => field.id), ...Object.values(config.fields).map(field => field.id)])];
  const views = readViews(github, config);
  state.views ??= {};
  for (const [key, name, layout, filter] of [["board", "Agent implementation", "BOARD_LAYOUT", "has:status"], ["table", "Agent specification", "TABLE_LAYOUT", state.selectedParent ? `parent-issue:"${config.repository}#${state.selectedParent}"` : ""]]) {
    const matches = views.filter(view => view.name === name);
    let view = views.find(view => view.id === (config.views?.[key] ?? state.views[key]?.id));
    if (!view && matches.length > 1) throw new TrackerError("project_view_ambiguous");
    view ??= matches[0];
    if (!view) view = github.graph(`mutation TrackerCreateView($input:CreateProjectV2ViewInput!){createProjectV2View(input:$input){view:projectV2View{${viewFields}}}}`, { input: { projectId: config.project.id, name, layout, configuration: { visibleFieldIds } } }).createProjectV2View.view;
    github.graph(`mutation TrackerUpdateView($input:UpdateProjectV2ViewInput!){updateProjectV2View(input:$input){view:projectV2View{id}}}`, { input: { viewId: view.id, name, layout, filter, configuration: { visibleFieldIds } } });
    state.views[key] = { id: view.id, name, layout, filter };
  }
  const actual = readViews(github, config);
  const board = actual.find(view => view.id === state.views.board.id);
  const table = actual.find(view => view.id === state.views.table.id);
  if (!board || board.layout !== "BOARD_LAYOUT" || board.filter !== "has:status" || !table || table.layout !== "TABLE_LAYOUT" || table.filter !== state.views.table.filter || !table.configuration?.visibleFields.nodes.some(field => field.id === parent.id)) throw new TrackerError("project_view_configuration_mismatch");
  // The public mutation has no group-by input. Report actual readback, then let
  // setup guidance direct the maintainer to the UI when grouping is absent.
  state.views.board.groupingVerified = board.groupByFields.nodes.some(field => field.id === config.fields.status.id);
}
