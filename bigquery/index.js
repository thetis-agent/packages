// @thetis/bigquery: Google BigQuery's REST API as tools, one shared client.
//
// Re-exports client.js for anyone who wants the pieces directly, and every
// tool function under the name package.json's "export" field uses.
export * from "./client.js";
export {
  status as bigqueryStatus,
  datasets as bigqueryDatasets,
  tables as bigqueryTables,
  table as bigqueryTable,
  query as bigqueryQuery,
  execute as bigqueryExecute,
  job as bigqueryJob,
  groupShards,
} from "./tools.js";
