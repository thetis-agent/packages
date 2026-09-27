// @bitmuse/vikunja: the Vikunja REST API as tools, one shared client.
//
// Re-exports client.js for anyone who wants the pieces directly, and every
// tool function under the name package.json's "export" field uses.
export * from "./client.js";
export {
  health as vikunjaHealth,
  projects as vikunjaProjects,
  projectSave as vikunjaProjectSave,
  projectDelete as vikunjaProjectDelete,
  views as vikunjaViews,
  viewSave as vikunjaViewSave,
  viewDelete as vikunjaViewDelete,
  board as vikunjaBoard,
  bucketSave as vikunjaBucketSave,
  bucketDelete as vikunjaBucketDelete,
  tasks as vikunjaTasks,
  taskGet as vikunjaTaskGet,
  taskCreate as vikunjaTaskCreate,
  taskUpdate as vikunjaTaskUpdate,
  taskMove as vikunjaTaskMove,
  taskDelete as vikunjaTaskDelete,
  labels as vikunjaLabels,
  comments as vikunjaComments,
  relate as vikunjaRelate,
  request as vikunjaRequest,
} from "./tools.js";
