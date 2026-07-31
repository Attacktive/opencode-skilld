/*
 * Keeps configured skills current by re-installing them from GitHub in the background.
 *
 * The refresh is never awaited: `gh skill install --all` takes upwards of a minute, and opencode loads plugins before it scans for skills, so awaiting it would put that minute on every single launch.
 * Whatever it downloads is picked up on the next launch instead.
 * Two toasts cover the wait, because a first launch that quietly comes up with no skills looks like something is broken.
 *
 * A running indicator is not on offer: toasts stack in a list and the plugin API exposes no toast id, so nothing can be updated or dismissed once shown.
 *
 * Nothing here is allowed to throw. A missing `gh`, an expired login, a plane — all of them have to degrade to an error toast rather than a broken launch.
 *
 * The default export is the only export this file may have: opencode walks every export of a plugin module and rejects the lot with "Plugin export is not a function" if one of them is not callable.
 * Everything else lives in `internals.ts`.
 */

import type { Plugin } from '@opencode-ai/plugin';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_INTERVAL_MS, TOAST_DELAY_MS, isEmpty, isSource, isStale, normalize, type Options } from './internals.ts';

const NOTICE_MS = 12_345;

/** Exhaustive against {@link Options} by construction: a key added there refuses to compile until it is mirrored here. */
const KNOWN_OPTIONS: Record<keyof Options, null> = { sources: null, interval: null };

const plugin: Plugin = async ({ client }, options) => {
	const loaded = Date.now();

	/** Decoration, so a TUI that is not listening — or not running at all, under `opencode run` — must never surface as an error. */
	const toast = (message: string, variant: 'info' | 'success' | 'error', duration?: number) => {
		const held = setTimeout(
			() => {
				client.tui.showToast({ body: { title: 'Skills', message, variant, duration } })
					.catch(() => {});
			},
			Math.max(0, TOAST_DELAY_MS - (Date.now() - loaded))
		);

		held.unref();
	};

	const given = (options ?? {}) as { [K in keyof Options]: unknown };

	// A typo'd key would otherwise make the plugin indistinguishable from one that was never configured.
	const strangers = Object.keys(given).filter((key) => !(key in KNOWN_OPTIONS));

	if (strangers.length > 0) {
		toast(`Ignoring unknown options: ${strangers.map((stranger) => `\`${stranger}\``).join(', ')}. The options are \`sources\` and \`interval\`.`, 'error');
	}

	const { sources = [], interval = DEFAULT_INTERVAL_MS } = given;

	if (!Array.isArray(sources)) {
		toast('Ignoring `sources`: it has to be an array of repositories.', 'error');
		return {};
	}

	let staleAfter = DEFAULT_INTERVAL_MS;

	if (typeof interval === 'number' && Number.isFinite(interval)) {
		staleAfter = interval;
	} else {
		toast(`Ignoring \`interval\`: ${JSON.stringify(interval)} is not a number of milliseconds.`, 'error');
	}

	for (const configured of sources) {
		if (!isSource(configured)) {
			toast(`Ignoring a malformed source: ${JSON.stringify(configured)}.`, 'error');
			continue;
		}

		// The catch at the bottom needs a name for the source no matter how little of the body ran.
		let label = JSON.stringify(configured);

		let notice: ReturnType<typeof setTimeout> | undefined = undefined;

		try {
			const source = normalize(configured);
			label = source.label;

			const { repo, target, stamp, placeholder } = source;

			let placeholderPath: string | undefined = undefined;

			if (placeholder !== false) {
				placeholderPath = `${target}/${placeholder}`;
			}

			// Both of these run before opencode scans for skills: the directory has to exist for a matching `skills.paths` entry to resolve on a machine that has never refreshed, and the placeholder has to be gone in case a previous refresh died between installing and cleaning up.
			mkdirSync(target, { recursive: true });

			if (placeholderPath) {
				rmSync(placeholderPath, { recursive: true, force: true });
			}

			if (!isStale(stamp, staleAfter)) {
				continue;
			}

			let announcement = `Refreshing ${label} from GitHub in the background.\nCarry on working — you will get a second message once it is done.`;

			const first = isEmpty(target);
			if (first) {
				announcement = `Fetching ${label} from GitHub in the background.\nThis usually takes a minute or so — carry on working, and you will get a second message the moment it is ready.`;
			}

			// Cancelled the moment the refresh settles: one that beats the TUI to it would otherwise promise a second message it has already sent, and a missing `gh` — which fails within milliseconds — would announce a download that never started.
			notice = setTimeout(
				() => toast(announcement, 'info', NOTICE_MS),
				TOAST_DELAY_MS
			);

			notice.unref();

			// `gh` is spawned directly rather than through a shell: the arguments need no quoting, and it keeps the one platform-specific assumption in this file from being "Git Bash is on PATH".
			const refresh = spawn(
				'gh',
				['skill', 'install', repo, '--all', '--dir', target, '--force'],
				{ stdio: 'ignore' }
			);

			// Node warns that `exit` may or may not follow `error`, so whichever fires first speaks for the child.
			let settled = false;

			refresh.on(
				'error',
				() => {
					if (settled) {
						return;
					}

					settled = true;
					clearTimeout(notice);
					toast(`Could not refresh ${label}: is \`gh\` installed and on PATH?`, 'error');
				}
			);

			refresh.on(
				'exit',
				(code: number | null, signal: NodeJS.Signals | null) => {
					if (settled) {
						return;
					}

					settled = true;
					clearTimeout(notice);

					if (signal !== null) {
						toast(`Failed to refresh ${label} (\`gh\` was killed by ${signal}).`, 'error');
						return;
					}

					if (code !== 0) {
						toast(`Failed to refresh ${label} (\`gh\` exited with code ${code}).`, 'error');
						return;
					}

					try {
						if (placeholderPath) {
							rmSync(placeholderPath, { recursive: true, force: true });
						}

						mkdirSync(dirname(stamp), { recursive: true });

						// Written last, so it records a refresh that actually finished and nothing else.
						writeFileSync(stamp, '');
					} catch {
						toast(`Refreshed ${label}, but could not record it — expect a redundant download next launch.`, 'error');
						return;
					}

					let message = `${label} has been refreshed.\nRestart opencode to pick up any changes.`;

					if (first) {
						message = `${label} is ready.\nRestart opencode to load it.`;
					}

					toast(message, 'success');
				}
			);

			/*
			 * Quitting opencode must never wait on a download, so the child is unreferenced — orphaned rather than killed.
			 * The handlers above go with the parent, so a refresh that outlives its launch finishes the download and then records nothing, costing one redundant download next launch.
			 */
			refresh.unref();
		} catch {
			clearTimeout(notice);
			toast(`Could not refresh ${label}.`, 'error');
		}
	}

	return {};
};

export default plugin;
