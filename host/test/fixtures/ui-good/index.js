// The command exports of the ui-good fixture. Each one exercises one branch of the gateway's command route.
export async function uiEcho(args, env) {
  return { text: "hi " + args.name, data: { session: env.session, user: env.user, role: env.role, cwd: typeof env.cwd, kernel: typeof env.kernel } };
}
export function uiSlow() {
  return new Promise(() => {});
}
export async function uiBoom() {
  throw new Error("no");
}
export async function uiAdmin() {
  return "admin ok";
}
export const NOT_A_FUNCTION = 1;
