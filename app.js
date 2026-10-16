import {
	initializeCloud,
	saveCloud
} from "./firebase.js";
const STORAGE_KEY = 'magic-playstyle-v4';

// shows the "See Result Details" dropdown with every category percentage
// set to false to hide it from the results page
const SHOW_ALL_PERCENTS = true;

let bank;
let history = [];
let current = 0;
let responses = {};
let lastUpdatedAt = 0;
let completed = false;
let retired = [];
let removed = [];
let cloudReady = false;

const $ = id => document.getElementById(id);
const questionById = id => bank.questions.find(q => q.id === id);

const isAnswered = q => {
	const value = responses[q.id];

	return q.type === 'rank'
		? Array.isArray(value) && value.length === q.answers.length
		: q.type === 'select'
			? Array.isArray(value) && value.length > 0
			: value !== undefined;
};


// drops saved answers that no longer fit their question,
// like a question that changed from single choice to rank
function cleanResponses(raw) {
	const out = {};

	for (const [id, value] of Object.entries(raw || {})) {
		const q = questionById(id);
		if (!q) continue;

		const count = (q.answers || []).length;
		const ok =
			q.type === 'rank'
				? Array.isArray(value) && value.length === count &&
					value.every(i => Number.isInteger(i) && i >= 0 && i < count)
				: q.type === 'select'
					? Array.isArray(value) && value.every(i => Number.isInteger(i) && i >= 0 && i < count)
					: q.type === 'scale'
						? typeof value === 'number' && value >= 1 && value <= 10
						: Number.isInteger(value) && value >= 0 && value < count;

		if (ok) out[id] = value;
	}

	return out;
}


function getQuizState() {
	return {
		questionBankVersion: bank.version,
		responses: structuredClone(responses),
		history: [...history],
		current,
		completed,
		retired: [...retired],
		removed: [...removed],
		clientUpdatedAt: lastUpdatedAt
	};
}

function persistLocal() {
	localStorage.setItem(
		STORAGE_KEY,
		JSON.stringify({
			...getQuizState(),
			version: bank.version
		})
	);
}

function save() {
	lastUpdatedAt = Math.max(
		Date.now(),
		lastUpdatedAt + 1
	);

	persistLocal();

	if (cloudReady) {
		saveCloud(getQuizState());
	}
}


// restores the review related state (finished flag, swapped out questions)
function applyExtras(data) {
	const valid = new Set(bank.questions.map(q => q.id));

	completed = data.completed === true;
	retired = (data.retired || []).filter(id => valid.has(id));
	removed = (data.removed || []).filter(id => valid.has(id));
}


function load() {
	try {
		const data = JSON.parse(
			localStorage.getItem(STORAGE_KEY)
		);

		if (!data || data.version !== bank.version) {
			return;
		}

		const valid = new Set(
			bank.questions.map(q => q.id)
		);

		responses = cleanResponses(
			Object.fromEntries(
				Object.entries(data.responses || {})
					.filter(([id]) => valid.has(id))
			)
		);

		history = (data.history || [])
			.filter(id => valid.has(id));

		current = Math.max(
			0,
			Math.min(
				data.current || 0,
				Math.max(0, history.length - 1)
			)
		);

		lastUpdatedAt = data.clientUpdatedAt || 0;
		applyExtras(data);

	} catch (error) {
		console.error("Could not load local progress:", error);
	}
}


function restoreCloudState(data) {
	if (!data) return;
	if (data.questionBankVersion !== bank.version) return;

	const valid = new Set(
		bank.questions.map(q => q.id)
	);

	responses = cleanResponses(
		Object.fromEntries(
			Object.entries(data.responses || {})
				.filter(([id]) => valid.has(id))
		)
	);

	history = (data.history || [])
		.filter(id => valid.has(id));

	current = Math.max(
		0,
		Math.min(
			data.current || 0,
			Math.max(0, history.length - 1)
		)
	);

	lastUpdatedAt = data.clientUpdatedAt || 0;
	applyExtras(data);
}

async function connectCloud() {
	if (cloudReady) return;

	try {
		const saved = await initializeCloud();

		// Whichever copy has the newer timestamp wins.
		if (
			saved &&
			saved.questionBankVersion === bank.version &&
			(saved.clientUpdatedAt || 0) > lastUpdatedAt
		) {
			restoreCloudState(saved);
		}

		initialHistory();
		persistLocal();

		cloudReady = true;

		// Upload the current state if cloud has no copy
		// or the local copy is more recent.
		if (
			!saved ||
			saved.questionBankVersion !== bank.version ||
			lastUpdatedAt > (saved.clientUpdatedAt || 0)
		) {
			save();
		}

	} catch (error) {
		console.error(
			"Firebase connection failed. Using local progress:",
			error
		);
	}
}


function initialHistory() {
	if (history.length) return;

	history = bank.questions
		.filter(q => q.phase === 'core')
		.map(q => q.id);

	current = 0;
}

function contribution(question, response) {
	const out = {};

	const add = (scores, factor) => {
		for (const [cat, weight] of Object.entries(scores)) {
			out[cat] = (out[cat] || 0) + weight * factor;
		}
	};

	if (response === undefined) return out;

	if (question.type === 'scale') {
		const strength = (Number(response) - 5.5) / 4.5;
		add(question.scores, strength);

	} else if (question.type === 'rank') {
		const weights = [1, 0.55, 0.15, -0.2];

		response.forEach((index, position) => {
			add(
				question.answers[index].scores,
				weights[position] || 0
			);
		});

	} else if (question.type === 'select') {
		response.forEach(index => {
			add(
				question.answers[index].scores,
				1 / response.length
			);
		});

	} else {
		add(question.answers[response].scores, 1);
	}

	return out;
}

function scoreProfile() {
	const output = {};
	for (const cat of Object.values(bank.categories).flat()) {
		output[cat] = {points: 0, exposure: 0, hits: 0, opportunities: 0};
	}
	for (const [id, response] of Object.entries(responses)) {
		const q = questionById(id);
		if (!q || !isAnswered(q)) continue;
		const earned = contribution(q, response);
		const options = q.type === 'scale' ? [q.scores] : q.answers.map(a => a.scores);
		for (const cat of Object.keys(output)) {
			const max = Math.max(0, ...options.map(o => Math.abs(o?.[cat] || 0)));
			if (!max) continue;
			output[cat].exposure += max;
			output[cat].opportunities++;
			output[cat].points += earned[cat] || 0;
			if ((earned[cat] || 0) > 0) output[cat].hits++;
		}
	}
	for (const stat of Object.values(output)) {
		// Strength is independent of the number of questions answered.
		// Evidence indicates how much support is behind that strength.
		stat.percent = stat.opportunities
			? Math.max(0, Math.min(100,
				Math.round(50 + 50 * stat.points / stat.exposure)))
			: 50;
		stat.strength = stat.percent;
		stat.evidence = Math.min(1, stat.opportunities / 4);
		stat.rankScore = Math.round(50 + (stat.percent - 50) * (0.65 + 0.35 * stat.evidence));
		stat.confidence =
			stat.opportunities >= 5 ? "More evidence" :
			stat.opportunities >= 3 ? "Some evidence" :
			stat.opportunities >= 1 ? "Limited evidence" :
			"Unexplored";
	}
	return output;
}

function chooseOptionalQuestion(candidates, stats, bank) {
	const groupFor = {};
	for (const [group, keys] of Object.entries(bank.categories)) {
		for (const key of keys) groupFor[key] = group;
	}
	const target = {Strategy: 3, Mechanics: 3, "Win Conditions": 3, Preferences: 2};
	let best = null;
	let bestScore = -Infinity;

	for (const q of candidates) {
		const sources = q.type === 'scale'
			? [q.scores] : q.answers.map(a => a.scores);
		const tags = [...new Set(sources.flatMap(s => Object.keys(s || {})))];
		let utility = 0;
		for (const tag of tags) {
			const stat = stats[tag];
			if (!stat) continue;
			const desired = target[groupFor[tag]] || 2;
			const gap = Math.max(0, desired - stat.opportunities) / desired;
			const uncertainty = 1 - (stat.evidence || 0);
			const interest = Math.max(0, (stat.rankScore - 50) / 50);
			utility += 1.5 * gap + 0.5 * uncertainty + 0.35 * interest;
		}
		// Reward useful breadth; avoid questions with many unrelated labels winning automatically.
		utility /= Math.sqrt(Math.max(1, tags.length));
		if (utility > bestScore) {
			best = q;
			bestScore = utility;
		}
	}
	return best;
}

function nextOptionalId() {
	const used = new Set([...history, ...retired]);
	const candidates = bank.questions.filter(q => q.phase === 'optional' && !used.has(q.id));
	return chooseOptionalQuestion(candidates, scoreProfile(), bank)?.id || null;
}

function el(tag, cls, text) {
	const node = document.createElement(tag);

	if (cls) node.className = cls;
	if (text !== undefined) node.textContent = text;

	return node;
}

function render() {
	$('quiz').classList.remove('hidden');
	$('results').classList.add('hidden');

	const q = questionById(history[current]);
	const optional = q.phase === 'optional';

	const optionalSeen = history.filter(
		id => questionById(id).phase === 'optional'
	).length;

	$('phaseLabel').textContent = optional
		? 'OPTIONAL QUESTIONS'
		: 'CORE QUESTIONS';

	// which optional question this is, counting from the first one
	const optionalPos = history
		.slice(0, current + 1)
		.filter(id => questionById(id).phase === 'optional')
		.length;

	// added questions in review mode push the total past the limit
	const optionalTotal = Math.max(bank.optionalLimit, optionalSeen);

	$('questionNumber').textContent = optional
		? `${optionalPos} / ${optionalTotal}`
		: `${current + 1} / ${bank.coreCount}`;

	$('progressBar').style.width = `${100 * (
		optional
			? optionalPos / optionalTotal
			: (current + 1) / bank.coreCount
	)}%`;

	$('questionText').textContent = q.question;

	const area = $('answers');
	area.replaceChildren();

	// Single-choice questions

	if (q.type === 'single') {
		q.answers.forEach((a, i) => {
			const b = el(
				'button',
				'answer' + (
					responses[q.id] === i ? ' selected' : ''
				),
				`${'ABCD'[i]}. ${a.text}`
			);

			b.type = 'button';

			b.onclick = () => {
				responses[q.id] = i;
				save();
				render();
			};

			area.append(b);
		});

	// Select up to two questions

	} else if (q.type === 'select') {
		const selected = responses[q.id] || [];

		const note = el(
			'p',
			'hint',
			'Select one or two.'
		);

		area.append(note);

		q.answers.forEach((a, i) => {
			const checked = selected.includes(i);

			const b = el(
				'button',
				'answer' + (checked ? ' selected' : ''),
				`${checked ? '[x]' : '[ ]'} ${a.text}`
			);

			b.type = 'button';

			b.disabled =
				!checked &&
				selected.length >= q.maxSelections;

			b.onclick = () => {
				responses[q.id] = checked
					? selected.filter(x => x !== i)
					: [...selected, i];

				save();
				render();
			};

			area.append(b);
		});

	// Rating-scale questions

	} else if (q.type === 'scale') {
		const value = responses[q.id];

		// smooth 1 to 10 slider, so 5.5 is the exact middle
		// the number is stored to the hundredths but never shown
		const range = el('input');

		range.type = 'range';
		range.min = '1';
		range.max = '10';
		range.step = '0.01';
		range.value = value ?? 5.5;

		range.setAttribute('aria-label', q.question);

		const commit = () => {
			responses[q.id] = Math.round(Number(range.value) * 100) / 100;
			removed = removed.filter(id => id !== q.id);

			save();
			$('nextBtn').disabled = false;
		};

		range.oninput = commit;

		// leaving the slider on the middle counts as an answer without touching it
		if (value === undefined && !removed.includes(q.id)) {
			responses[q.id] = 5.5;
			save();
		}

		// lets people pick the middle without having to drag away and back
		range.onpointerup = commit;

		// the step is tiny, so arrow keys nudge by half a point instead
		range.onkeydown = (e) => {
			let delta = 0;

			if (e.key === 'ArrowRight' || e.key === 'ArrowUp') delta = 0.5;
			if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') delta = -0.5;
			if (!delta) return;

			e.preventDefault();
			range.value = Math.max(1, Math.min(10, Number(range.value) + delta));
			commit();
		};

		const ends = el('div', 'scale-ends');

		ends.append(
			el('span', '', q.left || 'Not appealing'),
			el('span', 'scale-mid', q.mid || ''),
			el('span', '', q.right || 'Very appealing')
		);

		area.append(range, ends);

	// Ranking questions

	} else if (q.type === 'rank') {
		const order = Array.isArray(responses[q.id])
			? responses[q.id]
			: q.answers.map((_, i) => i);

		area.append(
			el(
				'p',
				'hint',
				'Put your favorite first. Use the arrows to reorder.'
			)
		);

		order.forEach((index, pos) => {
			const r = el('div', 'ranking-row');

			r.append(
				el('span', 'rank-number', `${pos + 1}.`),
				el(
					'span',
					'rank-label',
					q.answers[index].text
				)
			);

			for (const [symbol, shift] of [
				['↑', -1],
				['↓', 1]
			]) {
				const b = el(
					'button',
					'rank-button',
					symbol
				);

				b.type = 'button';

				b.disabled =
					pos + shift < 0 ||
					pos + shift >= order.length;

				b.setAttribute(
					'aria-label',
					`${shift < 0 ? 'Move up' : 'Move down'}: ${q.answers[index].text}`
				);

				b.onclick = () => {
					const updated = [...order];

					[
						updated[pos],
						updated[pos + shift]
					] = [
						updated[pos + shift],
						updated[pos]
					];

					responses[q.id] = updated;

					save();
					render();
				};

				r.append(b);
			}

			area.append(r);
		});

		if (!responses[q.id]) {
			const accept = el(
				'button',
				'secondary',
				'Use this order'
			);

			accept.type = 'button';

			accept.onclick = () => {
				responses[q.id] = [...order];

				save();
				render();
			};

			area.append(accept);
		}
	}

	$('backBtn').disabled = current === 0;
	$('nextBtn').disabled = !completed && !isAnswered(q);

	const isLast = current === history.length - 1;

	$('nextBtn').textContent =
		current === bank.coreCount - 1 && history.length === bank.coreCount
			? 'See Results'
			: (
				optional && isLast && optionalSeen >= bank.optionalLimit
					? 'Finish'
					: 'Continue'
			);

	$('resultsBtn').textContent = completed ? 'View Results' : 'Save and End';

	$('resultsBtn').classList.toggle(
		'hidden',
		!optional && !completed
	);

	renderReviewTools(q, optional);
}

// everything that only shows up once the quiz has been finished
function renderReviewTools(q, optional) {
	const nav = $('jumpNav');
	const tools = $('reviewTools');

	nav.classList.toggle('hidden', !completed);
	tools.classList.toggle('hidden', !completed);
	$('newQuestionBar').classList.toggle('hidden', !completed);

	// once finished, the results button moves down next to Remove Answer
	if (completed) tools.append($('resultsBtn'));
	else document.querySelector('#quiz .actions').append($('resultsBtn'));

	$('removeBtn').classList.toggle('hidden', !optional);

	nav.replaceChildren();
	if (!completed) return;

	const phase = optional ? 'optional' : 'core';
	let number = 0;

	history.forEach((id, index) => {
		const item = questionById(id);
		if (item.phase !== phase) return;

		number++;

		const button = el('button', 'jump', String(number));
		button.type = 'button';
		button.title = `Question ${number}`;
		button.classList.toggle('current', index === current);
		button.classList.toggle('unanswered', !isAnswered(item));
		button.onclick = () => {
			current = index;
			save();
			render();
		};

		nav.append(button);
	});

	if (optional) $('removeBtn').disabled = !isAnswered(q);

	const left = bank.questions.filter(
		x => x.phase === 'optional' && !history.includes(x.id)
	).length;

	$('newQuestionBtn').disabled = left === 0;
	$('newQuestionBtn').textContent = `New Question (${left} left)`;
}

function removeAnswer() {
	const q = questionById(history[current]);
	if (!completed || q.phase !== 'optional') return;

	delete responses[q.id];
	if (!removed.includes(q.id)) removed.push(q.id);

	save();
	render();
}

// adds one more optional question to the end of the quiz and jumps to it
function newQuestion() {
	if (!completed) return;

	const id = nextOptionalId();
	if (!id) return;

	history.push(id);
	current = history.length - 1;

	save();
	render();
}

function next() {
	const q = questionById(history[current]);

	if (!completed && !isAnswered(q)) return;

	if (
		(current === bank.coreCount - 1 && history.length === bank.coreCount) ||
		(
			q.phase === 'optional' &&
			current === history.length - 1 &&
			history.filter(
				id => questionById(id).phase === 'optional'
			).length >= bank.optionalLimit
		)
	) {
		return showResults();
	}

	if (current === history.length - 1) {
		const id = nextOptionalId();

		if (!id) return showResults();

		history.push(id);
	}

	current++;
	save();
	render();
}

// readable names for the frustration categories, display only
const FRUSTRATION_NAMES = {
	loss_creatures: 'Frustrated by losing creatures',
	loss_options: 'Frustrated by running out of options',
	loss_early: 'Frustrated by falling behind early',
	loss_setup: 'Frustrated by not drawing what I need',
	startup_frustration: 'Frustrated by slow starts'
};

function buildFullBreakdown(stats) {
	const root = el('div', 'full-breakdown');

	for (const [group, keys] of Object.entries(bank.categories)) {
		const section = el('div', 'group');
		section.append(el('h3', '', group));

		const rows = keys
			.map(key => ({ key, s: stats[key] }))
			.sort((a, b) =>
				(a.key in FRUSTRATION_NAMES) - (b.key in FRUSTRATION_NAMES) ||
				(b.s?.opportunities > 0) - (a.s?.opportunities > 0) ||
				(b.s?.rankScore ?? 0) - (a.s?.rankScore ?? 0) ||
				(b.s?.percent ?? 0) - (a.s?.percent ?? 0)
			);

		for (const { key, s } of rows) {
			const name = FRUSTRATION_NAMES[key] || key.replaceAll('_', ' ');
			const percent = s ? s.percent : 50;
			const count = s ? s.opportunities : 0;

			const row = el('div', 'score-row');
			const header = el('div', 'score-header');

			header.append(
				el('span', '', name),
				el('strong', '', `${percent}%`)
			);

			const track = el('div', 'track');
			const fill = el('div', 'fill');

			fill.style.width = `${percent}%`;
			track.append(fill);

			row.append(
				header,
				track,
				el(
					'div',
					'details',
					`Strength ${percent}% \u00b7 ${count} question${count === 1 ? '' : 's'} \u00b7 ${s ? s.confidence : 'Unexplored'}`
				)
			);

			section.append(row);
		}

		root.append(section);
	}

	return root;
}

function buildResultSummary(stats, make) {
	const root = make('div', 'playstyle-summary');

	// top 3 per group by the scoring's own ranking; anything tied for first is always included
	const SEP = ' \u2022 ';
	const top = (table) => {
		const ranked = Object.keys(table)
			.filter(key => stats[key]?.opportunities > 0)
			.sort((x, y) => stats[y].rankScore - stats[x].rankScore || stats[y].percent - stats[x].percent);

		if (!ranked.length) return { lead: [], rest: [] };

		const first = stats[ranked[0]];
		const same = (n, m) => Math.abs(n - m) < 0.01;

		const lead = ranked.filter(key =>
			same(stats[key].rankScore, first.rankScore) &&
			same(stats[key].percent, first.percent)
		);

		const rest = ranked.slice(lead.length, Math.max(3, lead.length));

		return { lead, rest };
	};

	const show = (heading, table) => {
		const { lead, rest } = top(table);
		const section = make('section', 'group');
		section.append(make('h3', '', heading));

		if (!lead.length) {
			section.append(
				make('strong', '', 'Not enough info yet'),
				make('p', 'hint', 'Answer a few more questions to see this one.')
			);
			root.append(section);
			return;
		}

		const text = key => `${table[key][0]} \u00b7 ${Math.round(stats[key].percent)}%`;

		const line = make('div', 'result-line');
		line.append(make('strong', '', lead.map(text).join(SEP)));

		if (rest.length) {
			line.append(make('span', 'result-others', SEP + rest.map(text).join(SEP)));
		}

		section.append(line);

		for (const key of lead) {
			section.append(make('p', 'hint', table[key][1]));
		}

		root.append(section);
	};

	const strategy = {
		aggro: ['Aggro', 'You like getting started fast and making things happen.'],
		midrange: ['Midrange', 'You like making steady progress and getting stronger as you go.'],
		control: ['Control', 'You like thinking ahead and having an answer when things change.'],
		combo: ['Combo', 'You like putting pieces together and seeing a plan work out.']
	};

	const mechanics = {
		stompy: ['Big creatures', 'You like big creatures that win fights.'],
		tokens: ['Lots of small creatures', 'You like filling the board with a big team.'],
		counters: ['Growing things', 'You like watching your stuff get bigger over time.'],
		voltron: ['One main character', 'You like putting everything into one creature.'],
		graveyard: ['Second chances', 'You like bringing things back from the graveyard.'],
		sacrifice: ['Trading things for rewards', 'You like giving things up to get something better.'],
		spellslinger: ['Casting lots of spells', 'You like chaining spells together.'],
		artifacts: ['Artifacts', 'You like clever gadgets doing their thing.'],
		enchantments: ['Lasting effects', 'You like cards that stay out and change the rules.'],
		politics: ['Making deals', 'You like talking and trading favors with the table.'],
		disruption: ['Getting in the way', 'You like messing with what other people are trying to do.'],
		theft: ['Borrowing tricks', "You like using other people's stuff against them."],
		typal: ['A matching team', 'You like a team of creatures that are all the same kind.'],
		lifegain: ['Gaining life', 'You like staying healthy and hard to kill.'],
		landfall: ['Playing lands', 'You like getting rewarded every time you play a land.'],
		blink: ['Reusing abilities', 'You like making creatures leave and come back to use their abilities again.'],
		value_engine: ['Getting extra value', 'You like cards that keep giving you more.'],
		synergy: ['Connecting the pieces', 'You like cards that work really well together.']
	};

	const win = {
		combat: ['Combat', 'You like winning by attacking with your creatures.'],
		commander_damage: ['Commander damage', 'You like winning by hitting with one standout commander.'],
		life_drain: ['Life drain', 'You like small advantages that slowly add up.'],
		burn: ['Burn', 'You like a direct, exciting finish.'],
		combo_win: ['Combo', 'You like making several things work together at just the right moment.'],
		attrition: ['Attrition', 'You like outlasting everyone and wearing them down.'],
		mill: ['Mill', 'You like winning by emptying out their deck.'],
		alternate_win: ['Alternate win', 'You like winning by doing something unusual.']
	};

	const style = {
		fast_pace: ['Fast games', 'You like games that move quickly.'],
		slow_pace: ['Slow games', 'You like games that take their time and build up.'],
		interaction: ['Interacting a lot', 'You like being in the middle of what everyone else is doing.'],
		low_interaction: ['Doing your own thing', 'You like focusing on your own plan.'],
		complexity: ['Lots of moving parts', 'You like having plenty to think about and keep track of.'],
		low_complexity: ['Keeping it simple', 'You like games that are easy to follow.'],
		decision_density: ['Lots of choices', 'You like having a decision to make every turn.'],
		high_risk: ['Taking big risks', 'You like plays that could go really well or really badly.'],
		low_risk: ['Playing it safe', 'You like steady plays you know will work.'],
		consistency: ['Reliable games', 'You like decks that do what you expect them to.'],
		resilience: ['Bouncing back', 'You like coming back after things go wrong.'],
		adaptability: ['Adapting on the fly', 'You like changing your plan to fit the game.'],
		burst: ['Big explosive turns', 'You like saving up for one huge turn.'],
		setup: ['Building up first', 'You like getting set up before the big stuff.'],
		social: ['Being social', 'You like the table talk as much as the cards.']
	};

	show('YOUR LIKELY PLAYSTYLE', strategy);
	show('WHAT YOU PROBABLY ENJOY', mechanics);
	show('HOW YOU PROBABLY LIKE TO WIN', win);
	show('HOW YOU PROBABLY LIKE TO PLAY', style);
	return root;
}

function showResults() {
	if (
		!bank.questions
			.filter(q => q.phase === 'core')
			.every(isAnswered)
	) {
		return render();
	}

	const optionalIds = history.filter(
		id => questionById(id).phase === 'optional'
	);

	if (
		!completed &&
		optionalIds.length >= bank.optionalLimit &&
		optionalIds.every(id => isAnswered(questionById(id)))
	) {
		completed = true;
		save();
	}

	$('newQuestionBar').classList.add('hidden');

	$('reviewBtn').classList.toggle('hidden', completed);
	$('reviewCoreBtn').classList.toggle('hidden', !completed);
	$('reviewOptionalBtn').classList.toggle('hidden', !completed);

	$('quiz').classList.add('hidden');
	$('results').classList.remove('hidden');

	const stats = scoreProfile();

	const total = Object.keys(responses)
		.filter(id => isAnswered(questionById(id)))
		.length;

	$('resultsDescription').textContent =
		`${total} questions answered. Here's what your answers say about you!`;

	const target = $('scoreGroups');
	target.replaceChildren();
	target.append(buildResultSummary(stats, el));

	if (SHOW_ALL_PERCENTS) {
		const details = el('details', 'result-details');

		details.append(
			el('summary', '', 'See Result Details'),
			buildFullBreakdown(stats)
		);

		target.append(details);
	}

	// The detailed 55-category breakdown remains available in admin.
	const debugPanel = $('debugOutput')?.closest('details');
	if (debugPanel) debugPanel.classList.add('hidden');

	$('debugOutput').textContent = JSON.stringify(
		{
			history,
			responses,
			stats
		},
		null,
		2
	);

	$('continueBtn').classList.toggle(
		'hidden',
		history.filter(
			id => questionById(id).phase === 'optional'
		).length >= bank.optionalLimit
	);
}

function refine() {
	const opt = history.findIndex(
		id =>
			questionById(id).phase === 'optional' &&
			!isAnswered(questionById(id))
	);

	if (opt >= 0) {
		current = opt;

	} else if (
		history.length > bank.coreCount &&
		current < history.length - 1
	) {
		current = history.length - 1;

	} else {
		const id = nextOptionalId();

		if (!id) return;

		history.push(id);
		current = history.length - 1;
	}

	save();
	render();
}

function bind() {
	$('backBtn').onclick = () => {
		if (current > 0) {
			current--;
			save();
			render();
		}
	};

	$('nextBtn').onclick = next;

	$('resultsBtn').onclick = showResults;

	$('continueBtn').onclick = refine;

	$('reviewBtn').onclick = () => {
		current = 0;
		save();
		render();
	};

	$('reviewCoreBtn').onclick = () => {
		current = 0;
		save();
		render();
	};

	$('reviewOptionalBtn').onclick = () => {
		const first = history.findIndex(
			id => questionById(id).phase === 'optional'
		);

		current = first >= 0 ? first : 0;
		save();
		render();
	};

	$('removeBtn').onclick = removeAnswer;
	$('newQuestionBtn').onclick = newQuestion;

	$('copyBtn').onclick = () => {
		navigator.clipboard.writeText(
			JSON.stringify(
				{
					responses,
					profile: scoreProfile()
				},
				null,
				2
			)
		)
		.then(() => {
			$('copyBtn').textContent = 'Copied';
		})
		.catch(() => {
			alert('Copy failed');
		});
	};

	
$('resetBtn').onclick = () => {
	if (!confirm('Start over and erase answers?')) {
		return;
	}

	history = [];
	responses = {};
	completed = false;
	retired = [];
	removed = [];
	current = 0;

	initialHistory();
	save();
	render();
};

}

async function init() {
	try {
		const res = await fetch('questions.json');

		if (!res.ok) {
			throw Error(`HTTP ${res.status}`);
		}

		bank = await res.json();

		if (
			bank.questions.length !== 60 ||
			bank.questions.filter(q => q.phase === 'core').length !== 15
		) {
			throw Error(
				'Question bank does not contain 15 core and 45 optional questions'
			);
		}

		
load();
initialHistory();

await connectCloud();

bind();

window.addEventListener("online", () => {
	if (cloudReady) {
		saveCloud(getQuizState());
	} else {
		connectCloud().catch(console.error);
	}
});


		if (
			bank.questions
				.filter(q => q.phase === 'core')
				.every(isAnswered)
		) {
			showResults();
		} else {
			render();
		}

	} catch (e) {
		$('quiz').classList.add('hidden');
		$('errorPanel').classList.remove('hidden');

		$('errorText').textContent =
			e.message +
			' — run through a local web server, not file://.';
	}
}

init();