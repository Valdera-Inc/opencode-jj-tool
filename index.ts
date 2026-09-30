import { tool, type Plugin } from '@opencode-ai/plugin';

const MAX_OUTPUT_LENGTH = 30_000;
const MAX_LOG_LIMIT = 100;

const JjPlugin: Plugin = async () => {
	return {
		tool: {
			jj: tool({
				description: 'Inspect Jujutsu status, revision history, or diffs. Only these read-only commands are available.',
				args: {
					command: tool.schema.enum(['status', 'log', 'diff'])
						.describe('Status, revision history, or diff'),
					revisions: tool.schema.string().optional()
						.describe('For log only: jj revision set to show'),
					limit: tool.schema.number().int().min(1).max(MAX_LOG_LIMIT).optional()
						.describe(`For log only: maximum revisions to return (1-${MAX_LOG_LIMIT}, default 20)`),
					patch: tool.schema.boolean().optional()
						.describe('For log only: include patches for the selected revisions'),
					revision: tool.schema.string().optional()
						.describe('For diff only: revision whose changes to show'),
					from: tool.schema.string().optional()
						.describe('For diff only: starting revision'),
					to: tool.schema.string().optional()
						.describe('For diff only: ending revision'),
					paths: tool.schema.array(tool.schema.string()).optional()
						.describe('For diff only: paths to include'),
					format: tool.schema.enum(['patch', 'summary']).optional()
						.describe('For diff only: patch (default) or summary'),
				},
				async execute(args, context) {
					const {
						command,
						revisions,
						limit = 20,
						patch = false,
						revision,
						from,
						to,
						paths = [],
						format = 'patch',
					} = args as {
						command: string;
						revisions?: string;
						limit?: number;
						patch?: boolean;
						revision?: string;
						from?: string;
						to?: string;
						paths?: string[];
						format?: string;
					};

					if (!['status', 'log', 'diff'].includes(command)) {
						return result({ ok: false, error: 'Unsupported command. Use status, log, or diff.' });
					}
					if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LOG_LIMIT) {
						return result({ ok: false, error: `Log limit must be an integer from 1 to ${MAX_LOG_LIMIT}.` });
					}
					const hasLogOptions = revisions !== undefined || args.limit !== undefined || args.patch !== undefined;
					const hasDiffOptions = revision !== undefined || from !== undefined || to !== undefined
						|| args.paths !== undefined || args.format !== undefined;
					if ((command === 'status' && (hasLogOptions || hasDiffOptions))
						|| (command === 'log' && hasDiffOptions)
						|| (command === 'diff' && hasLogOptions)) {
						return result({ ok: false, error: `Options do not apply to the ${command} command.` });
					}
					if (command === 'diff' && revision !== undefined && (from !== undefined || to !== undefined)) {
						return result({ ok: false, error: 'Use revision or from/to for diff, not both.' });
					}
					if (command === 'diff' && !['patch', 'summary'].includes(format)) {
						return result({ ok: false, error: 'Diff format must be patch or summary.' });
					}
					if (paths.length > 100 || paths.some((path) => path.length === 0 || path.length > 1000)) {
						return result({ ok: false, error: 'Provide at most 100 non-empty paths, each no longer than 1000 characters.' });
					}

					const jjArgs = ['--color=never', '--no-pager', command];
					if (command === 'log') {
						jjArgs.push('--no-graph', `--limit=${limit}`, '--template', 'json(self) ++ "\\n"');
						if (revisions !== undefined) jjArgs.push(`--revision=${revisions}`);
					} else if (command === 'diff') {
						jjArgs.push(format === 'summary' ? '--summary' : '--git');
						if (revision !== undefined) jjArgs.push(`--revisions=${revision}`);
						if (from !== undefined) jjArgs.push(`--from=${from}`);
						if (to !== undefined) jjArgs.push(`--to=${to}`);
						if (paths.length > 0) jjArgs.push('--', ...paths);
					}

					try {
						const process = Bun.spawn(['jj', ...jjArgs], {
							cwd: context.directory,
							stdout: 'pipe',
							stderr: 'pipe',
						});
						const [stdout, stderr, exitCode] = await Promise.all([
							new Response(process.stdout).text(),
							new Response(process.stderr).text(),
							process.exited,
						]);
						const boundedStderr = truncate(stderr.trimEnd());
						if (exitCode !== 0) {
							const boundedStdout = truncate(stdout.trimEnd());
							return result({
								ok: false,
								command,
								exitCode,
								stdout: boundedStdout.text,
								stderr: boundedStderr.text,
								truncated: boundedStdout.truncated || boundedStderr.truncated,
							});
						}

						if (command === 'log') {
							const commits = stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
							const returned: unknown[] = [];
							let truncated = false;
							for (const commit of commits) {
								const candidate = [...returned, commit];
								if (result({ ok: true, command, commits: candidate, truncated: false }).length > MAX_OUTPUT_LENGTH) {
									truncated = true;
									break;
								}
								returned.push(commit);
							}
							const response: Record<string, unknown> = {
								ok: true,
								command,
								commits: returned,
								truncated: truncated || returned.length < commits.length,
								...(boundedStderr.text ? { warnings: boundedStderr.text } : {}),
							};
							if (patch) {
								const patchArgs = [
									'--color=never', '--no-pager', 'log', '--no-graph', '--patch', `--limit=${limit}`,
								];
								if (revisions !== undefined) patchArgs.push(`--revision=${revisions}`);
								const patchProcess = Bun.spawn(['jj', ...patchArgs], {
									cwd: context.directory,
									stdout: 'pipe',
									stderr: 'pipe',
								});
								const [patchOutput, patchStderr, patchExitCode] = await Promise.all([
									new Response(patchProcess.stdout).text(),
									new Response(patchProcess.stderr).text(),
									patchProcess.exited,
								]);
								if (patchExitCode !== 0) {
									return result({
										ok: false,
										command,
										exitCode: patchExitCode,
										commits: returned,
										stderr: truncate(patchStderr.trimEnd()).text,
									});
								}
								const patchText = patchOutput.trimEnd();
								const remaining = Math.max(0, MAX_OUTPUT_LENGTH - result({ ...response, patch: '' }).length);
								const boundedPatch = patchText.length > remaining
									? `${patchText.slice(0, Math.max(0, remaining - 23))}\n[output truncated]`
									: patchText;
								response.patch = boundedPatch;
								response.truncated = response.truncated || boundedPatch.length < patchText.length;
								if (patchStderr.trim()) response.warnings = truncate(patchStderr.trimEnd()).text;
							}
							return result(response);
						}
						const boundedStdout = truncate(stdout.trimEnd());
						const key = command === 'status' ? 'status' : format === 'summary' ? 'summary' : 'patch';
						return result({
							ok: true,
							command,
							[key]: boundedStdout.text,
							...(boundedStderr.text ? { warnings: boundedStderr.text } : {}),
							truncated: boundedStdout.truncated || boundedStderr.truncated,
						});
					} catch (error) {
						return result({ ok: false, command, error: String(error) });
					}
				},
			}),
		},
	}
};

function truncate(value: string) {
	if (value.length <= MAX_OUTPUT_LENGTH) {
		return { text: value, truncated: false };
	}
	return {
		text: `${value.slice(0, MAX_OUTPUT_LENGTH)}\n[output truncated]`,
		truncated: true,
	};
}

function result(value: unknown) {
	return JSON.stringify(value, null, 2);
}

export default JjPlugin;
