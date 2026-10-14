
(async function () {
	"use strict";

	const response = await fetch("./questions.json");

	if (!response.ok) {
		throw new Error("Could not load questions.json");
	}

	const bank = await response.json();
	const questions = bank.questions;
	const core = questions.filter(q => q.phase === "core");
	const optional = questions.filter(q => q.phase === "optional");
	const groups = bank.categories;
	const categories = [...new Set(Object.values(groups).flat())];
	const byId = new Map(questions.map(q => [q.id, q]));

	const RANK_WEIGHTS = [1, 0.55, 0.15, -0.2];

	console.log("COMMANDER SCORING INTEGRITY TEST");
	console.log("--------------------------------");
	console.log(`${questions.length} questions loaded`);
	console.log(`${core.length} core / ${optional.length} optional`);
	console.log(`${categories.length} scoring categories`);

	function getGroup(category) {
		return Object.keys(groups).find(
			group => groups[group].includes(category)
		);
	}

	function contribution(q, value) {
		const result = {};

		function add(scores, multiplier) {
			for (const [category, weight] of Object.entries(scores || {})) {
				result[category] =
					(result[category] || 0) + weight * multiplier;
			}
		}

		if (value === undefined) return result;

		if (q.type === "scale") {
			add(q.scores, (value - 5.5) / 4.5);
		} else if (q.type === "rank") {
			value.forEach((index, position) => {
				add(q.answers[index].scores, RANK_WEIGHTS[position] || 0);
			});
		} else if (q.type === "select") {
			value.forEach(index => {
				add(q.answers[index].scores, 1 / value.length);
			});
		} else {
			add(q.answers[value].scores, 1);
		}

		return result;
	}

	function scoreProfile(answers) {
		const result = Object.fromEntries(
			categories.map(category => [
				category,
				{
					points: 0,
					exposure: 0,
					opportunities: 0,
					hits: 0
				}
			])
		);

		for (const [id, value] of Object.entries(answers)) {
			const q = byId.get(id);

			if (!q) continue;

			const earned = contribution(q, value);
			const options = q.type === "scale"
				? [q.scores]
				: q.answers.map(a => a.scores);

			for (const category of categories) {
				const maximum = Math.max(
					0,
					...options.map(o => Math.abs(o[category] || 0))
				);

				if (!maximum) continue;

				const stat = result[category];

				stat.exposure += maximum;
				stat.opportunities++;
				stat.points += earned[category] || 0;

				if ((earned[category] || 0) > 0) {
					stat.hits++;
				}
			}
		}

		for (const stat of Object.values(result)) {
			stat.percent = Math.max(
				0,
				Math.min(
					100,
					Math.round(
						50 + 50 * stat.points / (stat.exposure + 5)
					)
				)
			);
		}

		return result;
	}

	// Turn a hypothetical player's preferences into answers.
	// A preference can be positive or negative.
	function simulateAnswer(q, preferences, seed = 0) {
		function desirability(scores) {
			return Object.entries(preferences).reduce(
				(total, [category, preference]) =>
					total + preference * (scores?.[category] || 0),
				0
			);
		}

		if (q.type === "scale") {
			const match = desirability(q.scores);

			if (match > 0) return 10;
			if (match < 0) return 1;

			// Neutral for an unrelated rating.
			return 5;
		}

		const rankedOptions = q.answers.map((answer, index) => ({
			index,
			utility: desirability(answer.scores)
		}));

		// Rotate ties so unrelated questions don't always choose A.
		rankedOptions.sort((a, b) =>
			b.utility - a.utility ||
			((a.index + seed) % q.answers.length) -
			((b.index + seed) % q.answers.length)
		);

		if (q.type === "rank") {
			return rankedOptions.map(option => option.index);
		}

		if (q.type === "select") {
			const best = rankedOptions[0].utility;

			if (best <= 0) {
				return [rankedOptions[0].index];
			}

			return rankedOptions
				.filter(option => option.utility > 0)
				.slice(0, q.maxSelections || 2)
				.map(option => option.index);
		}

		return rankedOptions[0].index;
	}

	// Matches the adaptive question selection currently in app.js.
	function nextOptional(used, answers) {
		const stats = scoreProfile(answers);

		let best = null;
		let bestScore = -Infinity;

		for (const q of optional) {
			if (used.has(q.id)) continue;

			const sources = q.type === "scale"
				? [q.scores]
				: q.answers.map(a => a.scores);

			const tags = [
				...new Set(
					sources.flatMap(s => Object.keys(s))
				)
			];

			const utility = tags.reduce((sum, tag) => {
				const stat = stats[tag];

				return sum + (
					stat
						? (0.8 + stat.percent / 100) /
							(1 + stat.opportunities / 2)
						: 0
				);
			}, 0) / Math.max(1, tags.length);

			if (utility > bestScore) {
				best = q;
				bestScore = utility;
			}
		}

		return best;
	}

	function runPlayer(preferences, optionalCount = 0, seed = 0) {
		const answers = {};
		const used = new Set();

		for (let i = 0; i < core.length; i++) {
			const q = core[i];

			answers[q.id] = simulateAnswer(q, preferences, seed + i);
			used.add(q.id);
		}

		for (let i = 0; i < optionalCount; i++) {
			const q = nextOptional(used, answers);

			if (!q) break;

			answers[q.id] = simulateAnswer(
				q,
				preferences,
				seed + i + core.length
			);

			used.add(q.id);
		}

		return {
			answers,
			stats: scoreProfile(answers),
			questionCount: used.size,
			optionalIds: [...used].filter(
				id => byId.get(id).phase === "optional"
			)
		};
	}

	function categoryRank(stats, category) {
		const group = getGroup(category);

		if (!group) return null;

		const ranked = groups[group]
			.filter(key => stats[key].opportunities > 0)
			.sort((a, b) =>
				stats[b].percent - stats[a].percent ||
				stats[b].hits - stats[a].hits
			);

		const index = ranked.indexOf(category);

		return index < 0 ? null : index + 1;
	}

	// Test each scoring category as an isolated preference.
	const categoryResults = [];

	for (const category of categories) {
		const preferences = { [category]: 3 };

		const initial = runPlayer(preferences, 0, 1);
		const refined = runPlayer(preferences, 25, 1);

		categoryResults.push({
			category,
			group: getGroup(category),
			coreRank: categoryRank(initial.stats, category) ?? "N/A",
			coreScore: initial.stats[category].percent,
			coreExposure: initial.stats[category].opportunities,
			finalRank: categoryRank(refined.stats, category) ?? "N/A",
			finalScore: refined.stats[category].percent,
			finalExposure: refined.stats[category].opportunities,
			top3: (categoryRank(refined.stats, category) ?? 999) <= 3
		});
	}

	console.group("1. INDIVIDUAL CATEGORY TESTS");
	console.table(categoryResults);
	console.groupEnd();

	// More realistic hypothetical players with multiple preferences.
	const personalities = [
		{
			name: "Typal Army",
			preferences: {
				typal: 3,
				tokens: 2,
				combat: 2,
				control: -2
			},
			expected: ["typal", "tokens", "combat"]
		},
		{
			name: "Big Creature Player",
			preferences: {
				stompy: 3,
				counters: 2,
				midrange: 2,
				combat: 2
			},
			expected: ["stompy", "counters", "midrange"]
		},
		{
			name: "Single Champion",
			preferences: {
				voltron: 3,
				commander_damage: 3,
				combat: 2
			},
			expected: ["voltron", "commander_damage"]
		},
		{
			name: "Control Tactician",
			preferences: {
				control: 3,
				interaction: 3,
				disruption: 2,
				aggro: -2
			},
			expected: ["control", "interaction", "disruption"]
		},
		{
			name: "Sacrifice and Drain",
			preferences: {
				sacrifice: 3,
				life_drain: 3,
				graveyard: 2,
				attrition: 2
			},
			expected: ["sacrifice", "life_drain", "graveyard"]
		},
		{
			name: "Combo Spellcaster",
			preferences: {
				combo: 3,
				combo_win: 3,
				spellslinger: 2,
				complexity: 2
			},
			expected: ["combo", "combo_win", "spellslinger"]
		},
		{
			name: "Artifact Engineer",
			preferences: {
				artifacts: 3,
				value_engine: 3,
				synergy: 2
			},
			expected: ["artifacts", "value_engine"]
		},
		{
			name: "Mill Specialist",
			preferences: {
				mill: 3,
				attrition: 2,
				disruption: 1,
				combat: -2
			},
			expected: ["mill", "attrition"]
		},
		{
			name: "Political Negotiator",
			preferences: {
				politics: 3,
				negotiation: 3,
				social: 2,
				interaction: 1
			},
			expected: ["politics", "negotiation"]
		},
		{
			name: "Simple Combat",
			preferences: {
				combat: 3,
				stompy: 2,
				low_complexity: 3,
				complexity: -3
			},
			expected: ["combat", "stompy", "low_complexity"]
		}
	];

	const personalityResults = personalities.map((player, index) => {
		const result = runPlayer(player.preferences, 25, index + 10);

		return {
			player: player.name,
			expected: player.expected.join(", "),
			detected: player.expected.filter(
				cat => (categoryRank(result.stats, cat) ?? 999) <= 3
			).join(", ") || "None",
			matched: player.expected.filter(
				cat => (categoryRank(result.stats, cat) ?? 999) <= 3
			).length,
			total: player.expected.length,
			details: player.expected.map(cat =>
				`${cat}: #${categoryRank(result.stats, cat) ?? "N/A"}`
			).join(" | ")
		};
	});

	console.group("2. MIXED PLAYER PROFILES");
	console.table(personalityResults);
	console.groupEnd();

	// Audit how many questions can measure each category.
	const coverageResults = categories.map(category => {
		const count = pool => pool.filter(q => {
			const sources = q.type === "scale"
				? [q.scores]
				: q.answers.map(a => a.scores);

			return sources.some(scores => category in scores);
		}).length;

		return {
			category,
			core: count(core),
			optional: count(optional),
			total: count(questions)
		};
	});

	console.group("3. QUESTION COVERAGE");
	console.table(coverageResults);
	console.groupEnd();

	const top3 = categoryResults.filter(r => r.top3).length;
	const weakCore = coverageResults.filter(r => r.core < 2);
	const misses = personalityResults.filter(r => r.matched < r.total);

	console.group("4. SUMMARY");
	console.log(
		`Single-category recognition: ${top3}/${categories.length} top-three finishes`
	);
	console.log(
		`Categories with fewer than two core questions: ${weakCore.length}`
	);
	console.log(
		`Mixed profiles with missing expected top-three results: ${misses.length}/${personalities.length}`
	);

	if (weakCore.length) {
		console.warn("Low core coverage:", weakCore.map(r => r.category));
	}

	if (misses.length) {
		console.warn("Mixed profile mismatches:", misses.map(r => r.player));
	}

	console.groupEnd();

	// For experimenting manually without changing this file:
	window.commanderTests = {
		bank,
		runPlayer,
		scoreProfile,
		categoryRank,
		categoryResults,
		personalityResults,
		coverageResults
	};

	console.log("Manual testing available through window.commanderTests");
})();
