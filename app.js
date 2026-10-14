
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
		output[cat] = {
			points: 0,
			exposure: 0,
			hits: 0,
			opportunities: 0
		};
	}

	for (const [id, response] of Object.entries(responses)) {
		const q = questionById(id);

		if (!q || !isAnswered(q)) continue;

		const earned = contribution(q, response);

		const options = q.type === 'scale'
			? [q.scores]
			: q.answers.map(a => a.scores);

		for (const cat of Object.keys(output)) {
			const max = Math.max(
				0,
				...options.map(o => Math.abs(o[cat] || 0))
			);

			if (!max) continue;

			output[cat].exposure += max;
			output[cat].opportunities++;
			output[cat].points += earned[cat] || 0;

			if ((earned[cat] || 0) > 0) {
				output[cat].hits++;
			}
		}
	}

	for (const val of Object.values(output)) {
		// Neutral prior prevents one rare category
		// from immediately reaching 100%.

		val.percent = Math.round(
			50 + 50 * val.points / (val.exposure + 5)
		);

		val.percent = Math.max(
			0,
			Math.min(100, val.percent)
		);

		val.confidence =
			val.opportunities >= 5 ? 'More evidence' :
			val.opportunities >= 3 ? 'Some evidence' :
			val.opportunities > 0 ? 'Limited evidence' :
			'Unexplored';
	}

	return output;
}

function nextOptionalId() {
	const used = new Set(history);
	const stats = scoreProfile();

	const candidates = bank.questions.filter(
		q => q.phase === 'optional' && !used.has(q.id)
	);

	if (!candidates.length) return null;

	// Prioritize promising categories that have
	// received relatively little testing.

	let best = candidates[0];
	let bestScore = -Infinity;

	for (const q of candidates) {
		const sources = q.type === 'scale'
			? [q.scores]
			: q.answers.map(a => a.scores);

		const tags = [
			...new Set(
				sources.flatMap(s => Object.keys(s))
			)
		];

		const utility = tags.reduce((sum, tag) => {
			const st = stats[tag];

			return sum + (
				st
					? (0.8 + st.percent / 100) /
						(1 + st.opportunities / 2)
					: 0
			);
		}, 0) / Math.max(1, tags.length);

		if (utility > bestScore) {
			best = q;
			bestScore = utility;
		}
	}

	return best.id;
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
		`${total} questions answered. Scores show relative ` +
		`evidence, not certainty or a probability of liking a deck.`;

	const target = $('scoreGroups');
	target.replaceChildren();

	for (const [group, keys] of Object.entries(bank.categories)) {
		const section = el('section', 'group');

		section.append(el('h2', '', group));

		keys
			.filter(key => stats[key].exposure > 0)
			.sort(
				(a, b) =>
					stats[b].percent - stats[a].percent
			)
			.forEach(key => {
				const val = stats[key];

				const row = el('div', 'score-row');
				const head = el('div', 'score-header');

				head.append(
					el(
						'span',
						'',
						key.replaceAll('_', ' ')
					),
					el(
						'strong',
						'',
						`${val.percent}%`
					)
				);

				const track = el('div', 'track');
				const fill = el('div', 'fill');

				fill.style.width = `${val.percent}%`;
				track.append(fill);

				row.append(
					head,
					track,
					el(
						'div',
						'details',
						`${val.hits} positive signals · ` +
						`${val.opportunities} questions · ` +
						val.confidence
					)
				);

				section.append(row);
			});

		target.append(section);
	}

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
