/*
 * Everything `skilld.ts` needs but may not itself export.
 *
 * opencode walks every export of a plugin module and rejects the whole module with "Plugin export is not a function" if one of them is not callable, so the plugin file gets exactly one export and no more.
 * Nothing here is public API: it is split out to keep that file loadable and these helpers testable, and it changes with the implementation.
 */

import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';

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

/** Everything downstream trusts what this passes — `normalize` takes it without checking again — so the optional fields have to hold their documented types too, or a mistyped `target` becomes a crash instead of a toast. */
const isSource = (source: unknown): source is SkillSource => {
	if (typeof source === 'string') {
		return source.length > 0;
	}

	if (typeof source !== 'object' || source === null) {
		return false;
	}

	const { repo, target, stamp, label, placeholder } = source as { [K in keyof SkillRepository]: unknown };

	if (typeof repo !== 'string' || repo.length === 0) {
		return false;
	}

	for (const optional of [target, stamp, label]) {
		if (optional !== undefined && typeof optional !== 'string') {
			return false;
		}
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

/** Distinguishes a first launch, where `target` is missing outright, from a merely dated one. */
const isEmpty = (target: string) => {
	try {
		return readdirSync(target).length === 0;
	} catch {
		return true;
	}
};

export { DEFAULT_INTERVAL_MS, TOAST_DELAY_MS, DEFAULT_PLACEHOLDER, type SkillRepository, type SkillSource, type Options, type NormalizedSource, slugify, expand, asPlaceholder, isSource, normalize, isStale, isEmpty };
