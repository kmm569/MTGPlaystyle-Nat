
(async () => {
	"use strict";

	const SETTINGS = {
		runs: 20,
		optionalQuestions: 25,
		seed: 12345,
		recognitionThreshold: 10,
		neutralWarningThreshold: 70,
		neutralWarningRate: 0.20,
		preferenceStrength: 3
	};

	const response = await fetch("./questions.json");

	if (!response.ok) {
		throw new Error(`Could not load questions.json: ${response.status}`);
	}

	const bank = await response.json();
	const questions = bank.questions;
	const core = questions.filter(q => q.phase === "core");
	const optional = questions.filter(q => q.phase === "optional");
	const groups = bank.categories;
	const categories = [...new Set(Object.values(groups).flat())];
	const byId = new Map(questions.map(q => [q.id, q]));

	const RANK_WEIGHTS = [1, 0.55, 0.15, -0.2];

	if (questions.length !== 60 || core.length !== 15) {
		throw new Error("Expected 60 questions, including 15 core questions.");
	}

	// ------------------------------
	// Repeatable randomization
	// ------------------------------

	function createRandom(seed) {
		let state = seed >>> 0;

		return () => {
			state += 0x6D2B79F5;

			let t = state;

			t = Math.imul(t ^ (t >>> 15), t | 1);
			t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	function randomInteger(random, min, max) {
		return Math.floor(random() * (max - min + 1)) + min;
	}

	function shuffle(array, random) {
		const result = [...array];

		for (let i = result.length - 1; i > 0; i--) {
			const j = randomInteger(random, 0, i);

			[result[i], result[j]] = [result[j], result[i]];
		}

		return result;
	}

	function weightedChoice(utilities, random) {
		const temperature = 2.5;
		const maximum = Math.max(...utilities);

		const weights = utilities.map(value =>
			Math.exp((value - maximum) / temperature)
		);

		let roll = random() * weights.reduce((a, b) => a + b, 0);

		for (let i = 0; i < weights.length; i++) {
			roll -= weights[i];

			if (roll <= 0) return i;
		}

		return weights.length - 1;
	}

	// ------------------------------
	// Score calculation
	// Mirrors the V4/V5 quiz formula
	// ------------------------------

	function contribution(question, answer) {
		const result = {};

		function add(scores, factor) {
			for (const [category, weight] of Object.entries(scores || {})) {
				result[category] = (result[category] || 0) + weight * factor;
			}
		}

		if (answer === undefined) return result;

		if (question.type === "scale") {
			add(question.scores, (answer - 5.5) / 4.5);

		} else if (question.type === "rank") {
			answer.forEach((index, position) => {
				add(question.answers[index].scores, RANK_WEIGHTS[position] || 0);
			});

		} else if (question.type === "select") {
			answer.forEach(index => {
				add(question.answers[index].scores, 1 / answer.length);
			});

		} else {
			add(question.answers[answer].scores, 1);
		}

		return result;
	}

	function scoreProfile(answers) {
		const output = Object.fromEntries(
			categories.map(category => [
				category,
				{
					points: 0,
					exposure: 0,
					opportunities: 0,
					hits: 0,
					percent: 50
				}
			])
		);

		for (const [id, answer] of Object.entries(answers)) {
			const question = byId.get(id);

			if (!question) continue;

			const earned = contribution(question, answer);

			const sources = question.type === "scale"
				? [question.scores]
				: question.answers.map(a => a.scores);

			const availableCategories = new Set(
				sources.flatMap(source => Object.keys(source || {}))
			);

			for (const category of availableCategories) {
				if (!output[category]) continue;

				const maximum = Math.max(
					0,
					...sources.map(source =>
						Math.abs(source?.[category] || 0)
					)
				);

				if (!maximum) continue;

				const stat = output[category];
				const earnedPoints = earned[category] || 0;

				stat.exposure += maximum;
				stat.opportunities++;
				stat.points += earnedPoints;

				if (earnedPoints > 0) stat.hits++;
			}
		}

		for (const stat of Object.values(output)) {
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

		return output;
	}

	// ------------------------------
	// Simulated player responses
	// ------------------------------

	function utility(scores, preferences) {
		let value = 0;

		for (const [category, preference] of Object.entries(preferences)) {
			value += (scores?.[category] || 0) * preference;
		}

		return value;
	}

	function simulateAnswer(question, preferences, random) {
		if (question.type === "scale") {
			const preference = utility(question.scores, preferences);

			// Neutral players use the whole 1-10 range.
			// Preferences shift the distribution without
			// making every response perfectly predictable.
			const randomRating = randomInteger(random, 1, 10);

			if (preference === 0) return randomRating;

			const desiredRating = preference > 0 ? 10 : 1;
			const strength = Math.min(
				0.85,
				Math.abs(preference) / 12
			);

			return Math.max(
				1,
				Math.min(
					10,
					Math.round(
						randomRating * (1 - strength) +
						desiredRating * strength
					)
				)
			);
		}

		const utilities = question.answers.map(answer =>
			utility(answer.scores, preferences)
		);

		if (question.type === "rank") {
			const remaining = question.answers.map((_, i) => i);
			const ranking = [];

			while (remaining.length) {
				const currentUtilities = remaining.map(
					index => utilities[index]
				);

				const chosenPosition = weightedChoice(
					currentUtilities,
					random
				);

				ranking.push(remaining.splice(chosenPosition, 1)[0]);
			}

			return ranking;
		}

		if (question.type === "select") {
			const available = question.answers.map((_, i) => i);
			const selected = [];

			const count = random() < 0.65
				? Math.min(2, question.maxSelections || 2)
				: 1;

			while (selected.length < count && available.length) {
				const chosenPosition = weightedChoice(
					available.map(index => utilities[index]),
					random
				);

				selected.push(available.splice(chosenPosition, 1)[0]);
			}

			return selected;
		}

		return weightedChoice(utilities, random);
	}

	// ------------------------------
	// Adaptive question selection
	// Matches the current quiz logic
	// ------------------------------

	function nextOptional(used, answers) {
		const stats = scoreProfile(answers);

		let best = null;
		let bestScore = -Infinity;

		for (const question of optional) {
			if (used.has(question.id)) continue;

			const sources = question.type === "scale"
				? [question.scores]
				: question.answers.map(answer => answer.scores);

			const tags = [
				...new Set(
					sources.flatMap(scores => Object.keys(scores || {}))
				)
			];

			const score = tags.reduce((sum, tag) => {
				const stat = stats[tag];

				return sum + (
					stat
						? (0.8 + stat.percent / 100) /
							(1 + stat.opportunities / 2)
						: 0
				);
			}, 0) / Math.max(1, tags.length);

			if (score > bestScore) {
				best = question;
				bestScore = score;
			}
		}

		return best;
	}

	function runPlayer(preferences = {}, optionalCount = 25, seed = 1) {
		const random = createRandom(seed);
		const answers = {};
		const used = new Set();
		const optionalIds = [];

		for (const question of core) {
			answers[question.id] = simulateAnswer(
				question,
				preferences,
				random
			);

			used.add(question.id);
		}

		for (
			let i = 0;
			i < Math.min(optionalCount, SETTINGS.optionalQuestions);
			i++
		) {
			const question = nextOptional(used, answers);

			if (!question) break;

			answers[question.id] = simulateAnswer(
				question,
				preferences,
				random
			);

			used.add(question.id);
			optionalIds.push(question.id);
		}

		return {
			answers,
			stats: scoreProfile(answers),
			optionalIds,
			questionCount: used.size
		};
	}

	// ------------------------------
	// Category ranking
	// ------------------------------

	function getGroup(category) {
		return Object.keys(groups).find(
			name => groups[name].includes(category)
		);
	}

	function categoryRank(stats, category) {
		const groupName = getGroup(category);

		if (!groupName) return null;

		const ranked = groups[groupName]
			.filter(key => stats[key].opportunities > 0)
			.sort((a, b) =>
				stats[b].percent - stats[a].percent ||
				stats[b].hits - stats[a].hits
			);

		const position = ranked.indexOf(category);

		return position >= 0 ? position + 1 : null;
	}

	function average(values) {
		return values.reduce((a, b) => a + b, 0) /
			Math.max(1, values.length);
	}

	function percentile(values, fraction) {
		const sorted = [...values].sort((a, b) => a - b);

		const position = Math.min(
			sorted.length - 1,
			Math.floor(fraction * (sorted.length - 1))
		);

		return sorted[position];
	}

	// ------------------------------
	// Question coverage
	// ------------------------------

	function questionCovers(question, category) {
		const sources = question.type === "scale"
			? [question.scores]
			: question.answers.map(answer => answer.scores);

		return sources.some(scores =>
			Math.abs(scores?.[category] || 0) > 0
		);
	}

	const coverageResults = categories.map(category => ({
		category,
		group: getGroup(category),
		core: core.filter(q => questionCovers(q, category)).length,
		optional: optional.filter(q => questionCovers(q, category)).length,
		total: questions.filter(q => questionCovers(q, category)).length
	}));

	// ------------------------------
	// Neutral and preferred players
	// ------------------------------

	const categoryResults = [];

	console.log("COMMANDER SCORING INTEGRITY TEST");
	console.log("--------------------------------");
	console.log(`${questions.length} questions loaded`);
	console.log(`${core.length} core / ${optional.length} optional`);
	console.log(`${categories.length} scoring categories`);
	console.log(`${SETTINGS.runs} randomized runs per category`);
	console.log(`Random seed: ${SETTINGS.seed}`);

	for (const category of categories) {
		const neutralScores = [];
		const preferredScores = [];
		const neutralRanks = [];
		const preferredRanks = [];
		const corePreferredRanks = [];

		let preferredAboveNeutral = 0;

		for (let run = 0; run < SETTINGS.runs; run++) {
			const seed = SETTINGS.seed + run * 9973;

			const neutral = runPlayer(
				{},
				SETTINGS.optionalQuestions,
				seed
			);

			const preferred = runPlayer(
				{ [category]: SETTINGS.preferenceStrength },
				SETTINGS.optionalQuestions,
				seed
			);

			const corePreferred = runPlayer(
				{ [category]: SETTINGS.preferenceStrength },
				0,
				seed
			);

			const neutralScore = neutral.stats[category].percent;
			const preferredScore = preferred.stats[category].percent;

			neutralScores.push(neutralScore);
			preferredScores.push(preferredScore);

			neutralRanks.push(
				categoryRank(neutral.stats, category) ?? 999
			);

			preferredRanks.push(
				categoryRank(preferred.stats, category) ?? 999
			);

			corePreferredRanks.push(
				categoryRank(corePreferred.stats, category) ?? 999
			);

			if (preferredScore > neutralScore) {
				preferredAboveNeutral++;
			}
		}

		const neutralAverage = average(neutralScores);
		const preferredAverage = average(preferredScores);

		categoryResults.push({
			category,
			group: getGroup(category),
			neutralAverage: Math.round(neutralAverage),
			preferredAverage: Math.round(preferredAverage),
			improvement: Math.round(
				preferredAverage - neutralAverage
			),
			neutralP90: percentile(neutralScores, 0.9),
			falsePositiveRate: Math.round(
				100 * neutralScores.filter(
					score => score >= SETTINGS.neutralWarningThreshold
				).length / SETTINGS.runs
			),
			preferredWins: Math.round(
				100 * preferredAboveNeutral / SETTINGS.runs
			),
			coreTop3Rate: Math.round(
				100 * corePreferredRanks.filter(rank => rank <= 3).length /
				SETTINGS.runs
			),
			finalTop3Rate: Math.round(
				100 * preferredRanks.filter(rank => rank <= 3).length /
				SETTINGS.runs
			)
		});
	}

	// ------------------------------
	// Mixed player profiles
	// ------------------------------

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
				social: 2
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
		const matches = [];
		const ranks = {};

		for (const category of player.expected) {
			matches.push(0);
			ranks[category] = [];
		}

		for (let run = 0; run < SETTINGS.runs; run++) {
			const result = runPlayer(
				player.preferences,
				SETTINGS.optionalQuestions,
				SETTINGS.seed + index * 100000 + run * 9973
			);

			player.expected.forEach((category, i) => {
				const rank = categoryRank(result.stats, category) ?? 999;

				ranks[category].push(rank);

				if (rank <= 3) {
					matches[i]++;
				}
			});
		}

		return {
			player: player.name,
			expected: player.expected.join(", "),
			recognitionRate: Math.round(
				100 * matches.reduce((a, b) => a + b, 0) /
				(SETTINGS.runs * player.expected.length)
			),
			categoryRates: player.expected.map((category, index) =>
				`${category}: ${Math.round(100 * matches[index] / SETTINGS.runs)}%`
			).join(" | ")
		};
	});

	// ------------------------------
	// Final reports
	// ------------------------------

	const flagged = categoryResults.filter(row =>
		row.improvement < SETTINGS.recognitionThreshold ||
		row.falsePositiveRate > SETTINGS.neutralWarningRate * 100 ||
		row.preferredWins < 70
	);

	const weakCore = coverageResults.filter(row => row.core < 2);

	const unmeasured = coverageResults.filter(row => row.total === 0);

	const avgImprovement = average(
		categoryResults.map(row => row.improvement)
	);

	const avgRecognition = average(
		personalityResults.map(row => row.recognitionRate)
	);

	console.group("1. SUMMARY");

	console.table([{
		questions: questions.length,
		categories: categories.length,
		runsPerCategory: SETTINGS.runs,
		averageScoreLift: Math.round(avgImprovement),
		mixedProfileRecognition: `${Math.round(avgRecognition)}%`,
		flaggedCategories: flagged.length,
		weakCoreCategories: weakCore.length,
		unmeasuredCategories: unmeasured.length
	}]);

	console.groupEnd();

	console.group("2. CATEGORY RECOGNITION");
	console.table(
		[...categoryResults].sort(
			(a, b) => a.improvement - b.improvement
		)
	);
	console.groupEnd();

	console.group("3. FLAGGED CATEGORIES");
	console.table(flagged);
	console.groupEnd();

	console.group("4. MIXED PLAYER PROFILES");
	console.table(personalityResults);
	console.groupEnd();

	console.group("5. QUESTION COVERAGE");
	console.table(
		[...coverageResults].sort(
			(a, b) => a.total - b.total
		)
	);
	console.groupEnd();

	if (unmeasured.length) {
		console.warn(
			"Categories with no questions:",
			unmeasured.map(row => row.category)
		);
	}

	// Manual testing API
	window.commanderTests = {
		bank,
		settings: SETTINGS,
		runPlayer,
		scoreProfile,
		categoryRank,
		coverageResults,
		categoryResults,
		personalityResults,
		flagged
	};

	console.log("Tests complete. Manual API: window.commanderTests");
})().catch(error => {
	console.error("Scoring test failed:", error);
});
