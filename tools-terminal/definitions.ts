/** Declare argument schemas and mutability separately from request policy; TE-012, TE-018. */
import type { ToolDef } from '@/contracts/turn-events/types.ts';

const string = { type: 'string' };
const columns = { id: 'which command this is', running: 'whether it is still running', code: 'its exit code once it has finished' };
function tool(name: string, description: string, readOnly: boolean, properties: Record<string, unknown>, required: string[]): ToolDef {
  return { name, description, readOnly, endsTurn: false, source: 'tools-terminal@1.0.0', data: columns, schema: { type: 'object', properties, required } };
}
export const definitions = [
  tool('run_command', 'Run a shell command in the available space. Returns what it printed, or, if it is still going, a name you can read from later.', false,
    { command: string, name: { type: 'string', maxLength: 48 } }, ['command']),
  tool('read_command', 'Read what a running command has printed since you last read it.', true,
    { id: string, from_start: { type: 'boolean' } }, ['id']),
  tool('write_command', 'Type something into a running command, as if at its prompt.', false,
    { id: string, text: string, enter: { type: 'boolean' } }, ['id', 'text']),
  tool('stop_command', 'Stop a running command.', false, { id: string }, ['id']),
  tool('list_commands', 'List the commands running here and how they ended.', true, {}, [])
];
