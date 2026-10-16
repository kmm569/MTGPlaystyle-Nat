import {
	initializeCloud,
	saveCloud
} from "./firebase.js";
const STORAGE_KEY = 'magic-playstyle-v4';

let bank;
let history = [];
let current = 0;
let responses = {};
let lastUpdatedAt = 0;
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


function getQuizState() {
	return {
		questionBankVersion: bank.version,
		responses: structuredClone(responses),
		history: [...history],
		current,
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

		responses = Object.fromEntries(
			Object.entries(data.responses || {})
				.filter(([id]) => valid.has(id))
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

	responses = Object.fromEntries(
		Object.entries(data.responses || {})
			.filter(([id]) => valid.has(id))
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
	const used = new Set(history);
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

	$('questionNumber').textContent = optional
		? `${optionalSeen} / ${bank.optionalLimit}`
		: `${current + 1} / ${bank.coreCount}`;

	$('progressBar').style.width = `${100 * (
		optional
			? optionalSeen / bank.optionalLimit
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

		const label = el(
			'div',
			'scale-value',
			value === undefined
				? 'Choose a rating'
				: `${value} / 10`
		);

		const range = el('input');

		range.type = 'range';
		range.min = '1';
		range.max = '10';
		range.step = '1';
		range.value = value ?? 5;

		range.setAttribute('aria-label', q.question);

		range.oninput = () => {
			responses[q.id] = Number(range.value);
			label.textContent = `${range.value} / 10`;

			save();
			$('nextBtn').disabled = false;
		};

		const ends = el('div', 'scale-ends');

		ends.append(
			el('span', '', q.left || 'Not appealing'),
			el('span', 'scale-mid', q.mid || ''),
			el('span', '', q.right || 'Very appealing')
		);

		area.append(label, range, ends);

	// Ranking questions

	} else if (q.type === 'rank') {
		const order = responses[q.id] ||
			q.answers.map((_, i) => i);

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
	$('nextBtn').disabled = !isAnswered(q);

	$('nextBtn').textContent =
		current === bank.coreCount - 1
			? 'See Results'
			: (
				optional && optionalSeen >= bank.optionalLimit
					? 'Finish'
					: 'Continue'
			);

	$('resultsBtn').classList.toggle(
		'hidden',
		!optional
	);
}

function next() {
	const q = questionById(history[current]);

	if (!isAnswered(q)) return;

	if (
		current === bank.coreCount - 1 ||
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

function buildResultSummary(stats, make) {
	const root = make('div', 'playstyle-summary');
	const sorted = (keys) => keys
		.filter(key => stats[key]?.opportunities > 0)
		.sort((a, b) => stats[b].rankScore - stats[a].rankScore || stats[b].percent - stats[a].percent);
	const available = keys => sorted(keys)[0] || null;
	const note = (heading, label, description) => {
		const section = make('section', 'group');
		section.append(
			make('h3', '', heading),
			make('strong', '', label),
			make('p', 'hint', description)
		);
		root.append(section);
	};
	const strategy = {
		aggro: ['The Go-Getter', 'You like getting started and making things happen.'],
		midrange: ['The Builder', 'You like making steady progress and getting stronger as you go.'],
		control: ['The Planner', 'You like thinking ahead and having an answer when things change.'],
		combo: ['The Puzzle Solver', 'You like putting pieces together and seeing a plan work out.']
	};
	const win = {
		combat: ['Winning Together', 'You like building up a group and seeing it succeed.'],
		commander_damage: ['One Big Star', 'You like putting your effort into one standout character.'],
		life_drain: ['Little by Little', 'You like small advantages that really add up.'],
		burn: ['A Big Finish', 'You like a direct, exciting finish.'],
		combo_win: ['The Perfect Combination', 'You like making several things work together at just the right moment.'],
		attrition: ['Outlasting Everyone', 'You like sticking around and making steady progress.'],
		mill: ['An Unexpected Route', 'You like finding a different way to get to the finish line.'],
		alternate_win: ['A Secret Plan', 'You like winning by doing something unusual.']
	};
	const names = {
		stompy:'Big creatures', tokens:'Making a big team', counters:'Growing things',
		voltron:'One main character', graveyard:'Second chances', sacrifice:'Trading things for rewards',
		spellslinger:'Casting lots of spells', artifacts:'Clever gadgets', enchantments:'Lasting effects',
		politics:'Making deals', disruption:'Changing plans', theft:'Borrowing tricks',
		typal:'A matching team', lifegain:'Staying healthy', landfall:'Building resources',
		blink:'Reusing abilities', value_engine:'Getting extra value', synergy:'Connecting the pieces'
	};
	const topStrategy = available(Object.keys(strategy));
	if (topStrategy) note('YOUR MAIN PLAYSTYLE', ...strategy[topStrategy]);
	else note('YOUR MAIN PLAYSTYLE', 'Still figuring it out', 'Answer a few more questions to see your style.');

	const mechanics = sorted(Object.keys(names));
	const supported = mechanics.filter(key => stats[key].opportunities >= 2 && stats[key].rankScore >= 55);
	const favorites = (supported.length ? supported : mechanics).slice(0, 3).map(key => names[key]);
	note('WHAT YOU ENJOY', favorites.join(' · ') || 'A little of everything',
		'These are some of the things your answers leaned toward.');

	const topWin = available(Object.keys(win));
	if (topWin) note('YOUR FAVORITE WAY TO WIN', ...win[topWin]);

	// Each category contributes only if it has actually been measured.
	// Reverse-scored categories use (100 - score) to represent the opposite direction.
	function combined(positive, negative) {
		let sum = 0;
		let weight = 0;
		for (const key of positive) {
			const s = stats[key];
			if (!s || !s.opportunities) continue;
			const w = Math.min(1, s.opportunities / 3);
			sum += s.percent * w;
			weight += w;
		}
		for (const key of negative) {
			const s = stats[key];
			if (!s || !s.opportunities) continue;
			const w = Math.min(1, s.opportunities / 3);
			sum += (100 - s.percent) * w;
			weight += w;
		}
		return weight ? sum / weight : null;
	}
	const pacing = combined(['fast_pace', 'burst'], ['slow_pace', 'setup', 'consistency']);
	if (pacing === null) note('YOUR PLAYING SPEED', 'A Little of Both', 'There is not enough information to pick a speed yet.');
	else if (pacing < 40) note('YOUR PLAYING SPEED', 'Slow and Steady', 'You like taking your time and getting ready first.');
	else if (pacing < 65) note('YOUR PLAYING SPEED', 'A Little of Both', 'You like a mix of planning and jumping right in.');
	else note('YOUR PLAYING SPEED', 'Full Speed Ahead', 'You like getting started and keeping things moving.');

	const complexity = combined(
		['complexity', 'decision_density', 'board_complexity', 'engine_complexity'],
		['low_complexity']
	);
	if (complexity === null) note('HOW YOU LIKE YOUR GAMES', 'Still Figuring It Out', 'A few more answers could help here.');
	else if (complexity < 40) note('HOW YOU LIKE YOUR GAMES', 'Keep It Simple', 'You would rather have fun without too many things to track.');
	else if (complexity < 65) note('HOW YOU LIKE YOUR GAMES', 'A Little Challenge', 'You like interesting choices without too much homework.');
	else note('HOW YOU LIKE YOUR GAMES', 'Lots to Figure Out', 'You enjoy having plenty of little decisions and things to keep track of.');
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