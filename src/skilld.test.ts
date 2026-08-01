import type { PluginInput } from '@opencode-ai/plugin';
import { afterAll, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import * as pluginModule from './skilld.ts';
import plugin from './skilld.ts';
import { DEFAULT_INTERVAL_MS, TOAST_DELAY_MS, asInterval, asPlaceholder, expand, isEmpty, isSource, isStale, normalize, slugify, staging, swap } from './internals.ts';

const INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Every toast is held back until the TUI is listening, so nothing the plugin has to say can be observed before this.
 * Two tests wait it out in real time, which is why the suite takes about eight seconds rather than hanging.
 */
const UNTIL_TOASTS_LAND_MS = TOAST_DELAY_MS + 500;

const scratch = mkdtempSync(join(tmpdir(), 'skilld-'));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Toast {
	title: string;
	message: string;
	variant: string;
	duration?: number;
}

/** The sliver of {@link PluginInput} the plugin actually reaches for. The rest of it cannot be stood up, hence the cast below. */
interface ToastListener {
	client: {
		tui: {
			showToast: (options: { body: Toast }) => Promise<void>;
		};
	};
}

const listener = () => {
	const heard: Toast[] = [];

	const stub: ToastListener = {
		client: {
			tui: {
				showToast: async ({ body }) => { heard.push(body); }
			}
		}
	};

	return { heard, input: stub as unknown as PluginInput };
};

test(
	'the plugin module exports nothing but functions, or opencode refuses to load it at all',
	() => {
		// opencode walks every export and fails the whole module with "Plugin export is not a function" on the first one that is not callable, so a stray helper export silently costs you the entire plugin.
		const offenders = Object.entries(pluginModule)
			.filter(([, value]) => typeof value !== 'function')
			.map(([name]) => name);

		expect(offenders).toEqual([]);
	}
);

test(
	'slugify replaces the separator so a repo can name a directory',
	() => expect(slugify('anthropics/skills')).toBe('anthropics-skills')
);

test(
	'slugify leaves a name with nothing to replace alone',
	() => expect(slugify('skills')).toBe('skills')
);

test(
	'expand turns a leading tilde into a real path, since nothing here goes through a shell',
	() => {
		expect(expand('~/skills'))
			.toBe(`${homedir()}/skills`);

		expect(expand('~'))
			.toBe(homedir());
	}
);

test(
	'expand leaves a path alone when the tilde is not the whole first segment',
	() => {
		expect(expand('/opt/~/skills'))
			.toBe('/opt/~/skills');

		expect(expand('~user/skills'))
			.toBe('~user/skills');
	}
);

test(
	'asInterval defaults only when nothing was configured',
	() => {
		expect(asInterval(undefined))
			.toBe(DEFAULT_INTERVAL_MS);

		expect(asInterval(3_600_000))
			.toBe(3_600_000);
	}
);

test(
	'asInterval refuses whatever is not a finite number of milliseconds',
	() => {
		expect(asInterval('daily'))
			.toBeUndefined();

		expect(asInterval(Number.NaN))
			.toBeUndefined();

		expect(asInterval(Number.POSITIVE_INFINITY))
			.toBeUndefined();
	}
);

test(
	'asPlaceholder defaults only when nothing was configured',
	() => {
		expect(asPlaceholder(undefined))
			.toBe('template');

		expect(asPlaceholder('example'))
			.toBe('example');

		expect(asPlaceholder(false))
			.toBe(false);
	}
);

test(
	'asPlaceholder refuses anything that would point rmSync at the target itself',
	() => {
		expect(asPlaceholder(''))
			.toBe(false);

		expect(asPlaceholder('.'))
			.toBe(false);
	}
);

test(
	'asPlaceholder refuses anything that would point rmSync outside the target',
	() => {
		expect(asPlaceholder('..'))
			.toBe(false);

		expect(asPlaceholder('../../skills'))
			.toBe(false);

		expect(asPlaceholder('nested/template'))
			.toBe(false);

		expect(asPlaceholder('nested\\template'))
			.toBe(false);
	}
);

test(
	'isSource accepts the two documented shapes',
	() => {
		expect(isSource('anthropics/skills'))
			.toBe(true);

		expect(isSource({ repo: 'anthropics/skills' }))
			.toBe(true);

		expect(isSource({ repo: 'anthropics/skills', target: '~/skills', stamp: '~/stamp', label: 'the skills', placeholder: false }))
			.toBe(true);
	}
);

test(
	'isSource rejects whatever else a hand-written config file might hold',
	() => {
		expect(isSource(''))
			.toBe(false);

		expect(isSource({ target: '/skills' }))
			.toBe(false);

		expect(isSource({ repo: '' }))
			.toBe(false);

		expect(isSource({ repo: 42 }))
			.toBe(false);

		expect(isSource(null))
			.toBe(false);

		expect(isSource(undefined))
			.toBe(false);

		expect(isSource({ repo: 'anthropics/skills', target: 123 }))
			.toBe(false);

		expect(isSource({ repo: 'anthropics/skills', stamp: true }))
			.toBe(false);

		expect(isSource({ repo: 'anthropics/skills', label: {} }))
			.toBe(false);

		expect(isSource({ repo: 'anthropics/skills', placeholder: 123 }))
			.toBe(false);

		expect(isSource({ repo: 'anthropics/skills', target: '' }))
			.toBe(false);

		expect(isSource({ repo: 'anthropics/skills', stamp: '' }))
			.toBe(false);
	}
);

test(
	'normalize derives every path from a bare repo string',
	() => {
		const source = normalize('anthropics/skills');

		expect(source).toEqual({
			repo: 'anthropics/skills',
			target: `${homedir()}/.local/share/opencode/skills/anthropics-skills`,
			stamp: `${homedir()}/.local/state/opencode/anthropics-skills-refreshed`,
			label: 'anthropics/skills',
			placeholder: 'template'
		});
	}
);

test(
	'normalize fills the same defaults in for an object that only names a repo',
	() => {
		expect(normalize({ repo: 'anthropics/skills' }))
			.toEqual(normalize('anthropics/skills'));
	}
);

test(
	'normalize honours every override',
	() => {
		const overridden = {
			repo: 'someone/their-skills',
			target: '/skills',
			stamp: '/state/stamp',
			label: 'their skills',
			placeholder: 'example'
		};

		expect(normalize(overridden))
			.toEqual(overridden);
	}
);

test(
	'normalize keeps `placeholder: false` rather than defaulting it, so nothing is deleted',
	() => {
		expect(normalize({ repo: 'someone/their-skills', placeholder: false }).placeholder)
			.toBe(false);
	}
);

test(
	'normalize expands a tilde in the paths it was handed',
	() => {
		const source = normalize({ repo: 'someone/their-skills', target: '~/skills', stamp: '~/state/stamp' });

		expect(source.target)
			.toBe(`${homedir()}/skills`);

		expect(source.stamp)
			.toBe(`${homedir()}/state/stamp`);
	}
);

test(
	'normalize drops a placeholder that would have deleted the whole target',
	() => {
		expect(normalize({ repo: 'someone/their-skills', placeholder: '' }).placeholder)
			.toBe(false);
	}
);

test(
	'staging hides both directories beside the target, so a scan ignores them and the swap stays a rename',
	() => expect(staging('/skills/anthropic'))
		.toEqual({ incoming: '/skills/.anthropic.incoming', outgoing: '/skills/.anthropic.outgoing' })
);

test(
	'swap stands a finished download in for the live directory',
	() => {
		const target = join(scratch, 'swap-live');
		const { incoming, outgoing } = staging(target);

		mkdirSync(join(target, 'stale-skill'), { recursive: true });
		mkdirSync(join(incoming, 'fresh-skill'), { recursive: true });

		// Left over from an attempt that failed partway; the swap has to clear it rather than trip over it.
		mkdirSync(join(outgoing, 'debris'), { recursive: true });

		swap(target);

		expect(existsSync(join(target, 'fresh-skill')))
			.toBe(true);

		expect(existsSync(join(target, 'stale-skill')))
			.toBe(false);

		// Neither may outlive the swap, or the next launch would sweep a directory that had already gone live.
		expect(existsSync(incoming))
			.toBe(false);

		expect(existsSync(outgoing))
			.toBe(false);
	}
);

test(
	'swap installs a download when no live directory exists yet, as on a first refresh',
	() => {
		const target = join(scratch, 'swap-first-run');
		const { incoming } = staging(target);

		mkdirSync(join(incoming, 'fresh-skill'), { recursive: true });

		swap(target);

		expect(existsSync(join(target, 'fresh-skill')))
			.toBe(true);
	}
);

test(
	'swap puts the live directory back when there is nothing to stand in for it',
	() => {
		const target = join(scratch, 'swap-restore');
		mkdirSync(join(target, 'precious-skill'), { recursive: true });

		// No incoming directory at all, which is what a download that wrote nothing leaves behind — the live skills must survive it.
		expect(() => swap(target))
			.toThrow();

		expect(existsSync(join(target, 'precious-skill')))
			.toBe(true);
	}
);

test(
	'swap leaves no target behind when a first refresh has nothing to stand in',
	() => {
		const target = join(scratch, 'swap-first-run-restore');

		// No live directory and no incoming one either, which is a first refresh whose download wrote nothing. An empty `target` here would read as an installed-but-empty skill set.
		expect(() => swap(target))
			.toThrow();

		expect(existsSync(target))
			.toBe(false);
	}
);

test(
	'swap shrugs off a parked directory that will not clear, since the install itself has already succeeded',
	() => {
		const target = join(scratch, 'swap-cleanup');
		const { incoming, outgoing } = staging(target);

		mkdirSync(join(target, 'stale-skill'), { recursive: true });
		writeFileSync(join(target, 'stale-skill', 'SKILL.md'), '');
		mkdirSync(join(incoming, 'fresh-skill'), { recursive: true });

		/*
		 * Stripping the write bit keeps the parked skill's contents from being unlinked, which fails the final cleanup and nothing else.
		 * Windows ignores the bit on directories and root ignores it everywhere, so there the cleanup simply succeeds — the assertions hold either way.
		 */
		chmodSync(join(target, 'stale-skill'), 0o555);

		try {
			expect(() => swap(target))
				.not.toThrow();

			expect(existsSync(join(target, 'fresh-skill')))
				.toBe(true);
		} finally {
			const parked = join(outgoing, 'stale-skill');

			if (existsSync(parked)) {
				chmodSync(parked, 0o755);
			}
		}
	}
);

test(
	'isStale is stale when there is no stamp at all',
	() => {
		expect(isStale(join(scratch, 'never-refreshed'), INTERVAL_MS))
			.toBe(true);
	}
);

test(
	'isStale is fresh when the stamp was just written',
	() => {
		const stamp = join(scratch, 'just-refreshed');
		writeFileSync(stamp, '');

		expect(isStale(stamp, INTERVAL_MS))
			.toBe(false);
	}
);

test(
	'isStale is stale once the stamp is older than the interval',
	() => {
		const stamp = join(scratch, 'refreshed-long-ago');
		writeFileSync(stamp, '');

		const wellPastTheInterval = new Date(Date.now() - 2 * INTERVAL_MS);
		utimesSync(stamp, wellPastTheInterval, wellPastTheInterval);

		expect(isStale(stamp, INTERVAL_MS))
			.toBe(true);
	}
);

test(
	'isEmpty is empty when the directory does not exist',
	() => {
		expect(isEmpty(join(scratch, 'absent')))
			.toBe(true);
	}
);

test(
	'isEmpty is empty when the directory exists with nothing in it',
	() => {
		const target = join(scratch, 'bare');
		mkdirSync(target, { recursive: true });

		expect(isEmpty(target))
			.toBe(true);
	}
);

test(
	'isEmpty is not empty once a skill has been installed',
	() => {
		const target = join(scratch, 'populated');
		mkdirSync(join(target, 'some-skill'), { recursive: true });

		expect(isEmpty(target))
			.toBe(false);
	}
);

test(
	'the plugin says nothing at all until it is configured',
	async () => {
		const { heard, input } = listener();

		expect(await plugin(input, undefined))
			.toEqual({});

		expect(await plugin(input, { sources: [] }))
			.toEqual({});

		await Bun.sleep(UNTIL_TOASTS_LAND_MS);

		expect(heard).toEqual([]);
	},
	UNTIL_TOASTS_LAND_MS + 5_000
);

test(
	'the plugin reports malformed options rather than throwing on them',
	async () => {
		const cases = [
			{ sources: 'anthropics/skills' },
			{ sources: [{ target: '/nowhere' }] },
			{ sources: [{ repo: 'someone/their-skills', target: 123 }] },
			{ sources: [], interval: 'daily' },
			{ source: ['anthropics/skills'] }
		];

		const { heard, input } = listener();

		for (const options of cases) {
			expect(await plugin(input, options))
				.toEqual({});
		}

		await Bun.sleep(UNTIL_TOASTS_LAND_MS);

		expect(heard.map((toast) => toast.variant))
			.toEqual(['error', 'error', 'error', 'error', 'error']);

		// The typo'd `source` would otherwise be indistinguishable from a plugin that was never configured.
		expect(heard[4]?.message)
			.toContain('`source`');
	},
	UNTIL_TOASTS_LAND_MS + 5_000
);

test(
	'the plugin leaves the target alone when a placeholder would have taken it with it',
	async () => {
		const target = join(scratch, 'not-to-be-deleted');
		mkdirSync(join(target, 'precious-skill'), { recursive: true });
		writeFileSync(join(target, 'precious-skill', 'SKILL.md'), '');

		// A stamp written just now keeps the test off the network: the source counts as fresh, so the plugin only ensures the directory exists and sweeps staging.
		const stamp = join(scratch, 'refreshed-just-now');
		writeFileSync(stamp, '');

		const { input } = listener();

		await plugin(
			input,
			{
				sources: [{ repo: 'someone/their-skills', target, stamp, placeholder: '' }]
			}
		);

		expect(existsSync(join(target, 'precious-skill', 'SKILL.md')))
			.toBe(true);
	}
);
