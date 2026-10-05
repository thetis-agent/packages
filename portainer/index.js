// @thetis/portainer: the Portainer HTTP API as tools, one shared client.
//
// Re-exports client.js for anyone who wants the pieces directly, and every
// tool function under the name package.json's "export" field uses.
export * from "./client.js";
export {
  health as portainerHealth,
  environments as portainerEnvironments,
  stacks as portainerStacks,
  stackDeploy as portainerStackDeploy,
  stackUpdate as portainerStackUpdate,
  stackControl as portainerStackControl,
  stackDelete as portainerStackDelete,
  containers as portainerContainers,
  containerAction as portainerContainerAction,
  containerLogs as portainerContainerLogs,
  dockerResources as portainerDockerResources,
  docker as portainerDocker,
  kubernetes as portainerKubernetes,
  request as portainerRequest,
} from "./tools.js";
