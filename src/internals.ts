/*
 * Everything `skilld.ts` needs but may not itself export.
 *
 * opencode walks every export of a plugin module and rejects the whole module with "Plugin export is not a function" if one of them is not callable, so the plugin file gets exactly one export and no more.
 * Nothing here is public API: it is split out to keep that file loadable and these helpers testable, and it changes with the implementation.
 */

import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname } from 'node:path';

/** Refreshing more often than this buys nothing for a repository that lands changes on the order of once a week. */
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Long enough for the TUI to be listening. A toast fired while plugins are still loading goes nowhere.
 * A floor on every toast, not just the first: a spawn failure lands within milliseconds, and its error toast would otherwise be the one nobody ever sees.
 */
const TOAST_DELAY_MS = 3333;

/**
 * Template repositories on GitHub commonly ship a placeholder skill described as "Replace with description of the skill and when Claude should use it."
 * It has a description, so opencode will not filter it out, and a trigger that vague fires on almost anything.
 * Set a source's `placeholder` to `false` if its repository does not ship one.
 */
const DEFAULT_PLACEHOLDER = 'template';

interface SkillRepository {
	/**
	 * A GitHub `"owner/repo"` to pull skills from, e.g. `"anthropics/skills"`.
	 */
	repo: string;

	/**
	 * Where to install this source's skills.
	 * Defaults to a slug of {@link repo} under `~/.local/share/opencode/skills`.
	 */
	target?: string;

	/**
	 * Where to record a successful refresh.
	 * Defaults to a slug of {@link repo} under `~/.local/state/opencode`.
	 */
	stamp?: string;

	/**
	 * Name used in toasts.
	 * Defaults to {@link repo}.
	 */
	label?: string;

	/**
	 * Name of a placeholder skill directory to delete after install, or `false` to keep whatever upstream ships.
	 * Defaults to {@link DEFAULT_PLACEHOLDER}.
	 */
	placeholder?: string | false;
}

type SkillSource = string | SkillRepository;

/** The documented shape of the options. Nothing enforces it — they come from a handwritten config file — so everything below validates rather than trusts. */
interface Options {
	/**
	 * Repositories to refresh skills from.
	 * Empty by default, so the plugin is a no-op until configured.
	 */
	sources?: SkillSource[];

	/**
	 * How often to refresh, in milliseconds.
	 * Defaults to {@link DEFAULT_INTERVAL_MS}.
	 */
	interval?: number;
}

interface NormalizedSource {
	repo: string;
	target: string;
	stamp: string;
	label: string;
	placeholder: string | false;
}

const slugify = (repo: string) => repo.replace(/\//g, '-');

/** `~` is a shell convention and nothing here goes through a shell, so an unexpanded path would become a directory literally named `~`. */
const expand = (path: string) => {
	if (path === '~') {
		return homedir();
	}

	if (path.startsWith('~/')) {
		return `${homedir()}${path.slice(1)}`;
	}

	return path;
};

/**
 * Refuses anything that is not a single directory name.
 * The placeholder is deleted with a recursive, forced `rmSync`, so an empty string would aim that at `target` itself and a path would aim it somewhere else entirely.
 */
const asPlaceholder = (placeholder: unknown): string | false => {
	if (placeholder === undefined) {
		return DEFAULT_PLACEHOLDER;
	}

	if (typeof placeholder !== 'string') {
		return false;
	}

	if (placeholder.length === 0 || placeholder === '.' || placeholder === '..' || placeholder.includes('/') || placeholder.includes('\\')) {
		return false;
	}

	return placeholder;
};

/** A non-empty string, which is the only text an option may hold: `''` survives `expand` untouched, so a `target` of `''` would reach `mkdirSync` as `''` and report itself as an unrefreshable source rather than a mistyped one. */
const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** Absent or a non-empty string — the shape every optional text field has to fit. */
const isOptionalText = (value: unknown) => value === undefined || isText(value);

/** The interval is taken only as a finite number of milliseconds: absent falls back to the default, and anything else comes back as `undefined` so the caller can complain. */
const asInterval = (interval: unknown): number | undefined => {
	if (interval === undefined) {
		return DEFAULT_INTERVAL_MS;
	}

	if (typeof interval === 'number' && Number.isFinite(interval)) {
		return interval;
	}

	return undefined;
};

/** Everything downstream trusts what this passes — `normalize` takes it without checking again — so the optional fields have to hold their documented types too, or a mistyped `target` becomes a crash instead of a toast. */
const isSource = (source: unknown): source is SkillSource => {
	if (typeof source === 'string') {
		return source.length > 0;
	}

	if (typeof source !== 'object' || source === null) {
		return false;
	}

	const { repo, target, stamp, label, placeholder } = source as { [K in keyof SkillRepository]: unknown };

	if (!isText(repo)) {
		return false;
	}

	if (![target, stamp, label].every(isOptionalText)) {
		return false;
	}

	return placeholder === undefined || typeof placeholder === 'string' || placeholder === false;
};

const normalize = (source: SkillSource): NormalizedSource => {
	let configured: SkillRepository;
	if (typeof source === 'string') {
		configured = { repo: source };
	} else {
		configured = source;
	}

	const slug = slugify(configured.repo);

	/*
	 * Deliberately not `~/.config/opencode/skills/<slug>`, tempting as that is for saving the user a `skills.paths` entry.
	 * opencode discovers skills exactly one level deep, so a per-source subdirectory there is never found — and a directory of its own is what makes the swap safe, since a refresh replaces all of `target` and would take anything else living there with it.
	 * This XDG-shaped layout is what opencode uses on Windows too, so the same defaults are correct there and must not be moved to `%APPDATA%`.
	 */
	const target = expand(configured.target ?? `${homedir()}/.local/share/opencode/skills/${slug}`);
	const stamp = expand(configured.stamp ?? `${homedir()}/.local/state/opencode/${slug}-refreshed`);

	return {
		repo: configured.repo,
		target,
		stamp,
		label: configured.label ?? configured.repo,
		placeholder: asPlaceholder(configured.placeholder)
	};
};

/** A stamp that cannot be read counts as stale: there has never been a successful refresh to go by. */
const isStale = (stamp: string, interval: number) => {
	try {
		const age = Date.now() - statSync(stamp).mtimeMs;

		return age > interval;
	} catch {
		return true;
	}
};

/**
 * Where a download is assembled before it stands in for the live directory, and where the live one is parked while they trade places.
 * Siblings of `target` rather than anything under `os.tmpdir()`, because a rename across filesystems fails with `EXDEV` and the copy it would take instead is not atomic.
 * Hidden, because a sibling is a sibling: point `skills.paths` at the parent directory and an unhidden one would be scanned as a skill with no `SKILL.md` in it.
 */
const staging = (target: string) => {
	const hidden = `${dirname(target)}/.${basename(target)}`;

	return { incoming: `${hidden}.incoming`, outgoing: `${hidden}.outgoing` };
};

/**
 * Stands a finished download in for the live directory, so a half-written one is never what opencode scans.
 * Not a single atomic step — nothing Node exposes can exchange two directories — but `target` is absent for two renames rather than for the length of a download.
 */
const swap = (target: string) => {
	const { incoming, outgoing } = staging(target);

	rmSync(outgoing, { recursive: true, force: true });

	// A first refresh has no live directory to move aside, and conjuring an empty one costs less than a branch for it.
	mkdirSync(target, { recursive: true });
	renameSync(target, outgoing);

	try {
		renameSync(incoming, target);
	} catch (error) {
		// Never leave nothing behind: put the live directory back and let the caller report it.
		renameSync(outgoing, target);

		throw error;
	}

	try {
		rmSync(outgoing, { recursive: true, force: true });
	} catch {
		// The download is already live, so a parked directory that will not clear is no failed install — it is hidden, and the next launch sweeps it.
	}
};

/** Distinguishes a first launch, where `target` is missing outright, from a merely dated one. */
const isEmpty = (target: string) => {
	try {
		return readdirSync(target).length === 0;
	} catch {
		return true;
	}
};

export { DEFAULT_INTERVAL_MS, TOAST_DELAY_MS, DEFAULT_PLACEHOLDER, type SkillRepository, type SkillSource, type Options, type NormalizedSource, slugify, expand, asInterval, asPlaceholder, isSource, normalize, staging, swap, isStale, isEmpty };
