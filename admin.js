import {
	initializeApp
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";

import {
	getAuth,
	onAuthStateChanged,
	signInWithEmailAndPassword,
	signOut
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";

import {
	getFirestore,
	collection,
	getDocs
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";

const firebaseConfig = {
	apiKey: "AIzaSyBjQtmuR8InViQqdAXNyoLK87jUXpBGj7g",
	authDomain: "mtgplaystyler.firebaseapp.com",
	projectId: "mtgplaystyler",
	storageBucket: "mtgplaystyler.firebasestorage.app",
	messagingSenderId: "48485613789",
	appId: "1:48485613789:web:35a10c16e5e1dd9e80db34"
};

// Match this to the UID in your Firestore rules.
const ADMIN_UID = "KzVaRhTOi2RTiXmL7Gw6bv2Alhj1";

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);

let bank = null;
let sessions = [];
let selectedSession = null;

const $ = id => document.getElementById(id);

function element(tag, className, content) {
	const node = document.createElement(tag);

	if (className) node.className = className;
	if (content !== undefined) node.textContent = content;

	return node;
}

function questionById(id) {
	return bank.questions.find(q => q.id === id);
}

function isValidResponse(question, response) {
	if (!question || response === undefined || response === null) {
		return false;
	}

	if (question.type === "rank") {
		return Array.isArray(response)
			&& response.length === question.answers.length
			&& new Set(response).size === question.answers.length
			&& response.every(i =>
				Number.isInteger(i) &&
				i >= 0 &&
				i < question.answers.length
			);
	}

	if (question.type === "select") {
		return Array.isArray(response)
			&& response.length > 0
			&& response.length <= (question.maxSelections || 2)
			&& response.every(i =>
				Number.isInteger(i) &&
				i >= 0 &&
				i < question.answers.length
			);
	}

	if (question.type === "scale") {
		// the slider saves decimals like 7.34
		return typeof response === "number"
			&& Number.isFinite(response)
			&& response >= 1
			&& response <= 10;
	}

	return Number.isInteger(response)
		&& response >= 0
		&& response < question.answers.length;
}

const SPREAD = 1.3;

function calculateScores(responses) {
	const stats = {};

	for (const category of Object.values(bank.categories).flat()) {
		stats[category] = {
			points: 0,
			exposure: 0,
			opportunities: 0,
			hits: 0
		};
	}

	for (const [id, response] of Object.entries(responses)) {
		const question = questionById(id);

		if (!isValidResponse(question, response)) continue;

		const earned = {};

		function add(scores, factor) {
			for (const [category, weight] of Object.entries(scores)) {
				earned[category] =
					(earned[category] || 0) + weight * factor;
			}
		}

		let options;

		if (question.type === "scale") {
			const strength = (response - 5.5) / 4.5;

			add(question.scores, strength);
			options = [question.scores];

		} else {
			options = question.answers.map(a => a.scores);

			if (question.type === "rank") {
				const weights = [1, 0.4, -0.4, -1];

				response.forEach((index, position) => {
					add(
						question.answers[index].scores,
						weights[position] || 0
					);
				});

			} else if (question.type === "select") {
				const rest = question.answers.length - response.length;
				question.answers.forEach((answer, index) => {
					add(
						answer.scores,
						response.includes(index)
							? 1 / response.length
							: (rest ? -0.5 / rest : 0)
					);
				});

			} else {
				const others = question.answers.length - 1;
				question.answers.forEach((answer, index) => {
					add(answer.scores, index === response ? 1 : -0.5 / others);
				});
			}
		}

		for (const category of Object.keys(stats)) {
			const maximum = Math.max(
				0,
				...options.map(
					o => Math.abs(o[category] || 0)
				)
			);

			if (!maximum) continue;

			stats[category].exposure += maximum;
			stats[category].opportunities++;
			stats[category].points += earned[category] || 0;

			if ((earned[category] || 0) > 0) {
				stats[category].hits++;
			}
		}
	}

	for (const stat of Object.values(stats)) {
		// Strength is independent of the number of questions answered.
		// Evidence indicates how much support is behind that strength.
		stat.raw = stat.opportunities
			? Math.max(0, Math.min(100,
				Math.round(50 + 50 * stat.points / stat.exposure)))
			: 50;
		// A category with only a question or two behind it is pulled toward 50,
		// so it has to be backed by more answers before it can beat a well measured one.
		const shrunk = 50 + (stat.raw - 50) * stat.opportunities / (stat.opportunities + 3);
		stat.percent = Math.max(0, Math.min(100, Math.round(50 + (shrunk - 50) * SPREAD)));
		stat.strength = stat.percent;
		stat.evidence = Math.min(1, stat.opportunities / 4);
		stat.rankScore = stat.percent;
		stat.confidence =
			stat.opportunities >= 5 ? "More evidence" :
			stat.opportunities >= 3 ? "Some evidence" :
			stat.opportunities >= 1 ? "Limited evidence" :
			"Unexplored";
	}

	return stats;
}

function getAnswerText(question, value) {
	if (!isValidResponse(question, value)) {
		return "Unanswered or invalid response";
	}

	if (question.type === "scale") {
		return `${value} / 10`;
	}

	if (question.type === "rank") {
		return value.map((index, position) =>
			`${position + 1}. ${question.answers[index].text}`
		).join("\n");
	}

	if (question.type === "select") {
		return value.map(index =>
			question.answers[index].text
		).join("\n");
	}

	return question.answers[value].text;
}

function getProgress(session) {
	const responses = session.responses || {};

	const core = bank.questions
		.filter(q => q.phase === "core")
		.filter(q => isValidResponse(q, responses[q.id]))
		.length;

	const optional = bank.questions
		.filter(q => q.phase === "optional")
		.filter(q => isValidResponse(q, responses[q.id]))
		.length;

	// questions can be added after finishing, so count what the session actually has
	const optionalAsked = (session.history || []).filter(id =>
		questionById(id)?.phase === "optional"
	).length;

	return {
		core,
		optional,
		optionalAsked: Math.max(bank.optionalLimit || 25, optionalAsked),
		total: core + optional
	};
}

function formatDate(timestamp) {
	if (!timestamp?.toDate) return "Date unavailable";

	return timestamp.toDate().toLocaleString();
}

async function loadSessions() {
	$("dashboardStatus").textContent = "Loading sessions...";

	try {
		const snapshot = await getDocs(
			collection(db, "quizSessions")
		);

		sessions = snapshot.docs.map(doc => ({
			id: doc.id,
			...doc.data()
		}));

		sessions.sort((a, b) =>
			(b.updatedAt?.toMillis?.() || 0) -
			(a.updatedAt?.toMillis?.() || 0)
		);

		$("dashboardStatus").textContent =
			`${sessions.length} saved session(s)`;

		if (
			selectedSession &&
			!sessions.some(s => s.id === selectedSession.id)
		) {
			selectedSession = null;
			$("sessionDetails").classList.add("hidden");
			$("sessionList").classList.remove("hidden");
		}

		renderSessionList();

		if (selectedSession) {
			const refreshed = sessions.find(
				s => s.id === selectedSession.id
			);

			if (refreshed) showSession(refreshed);
		}

	} catch (error) {
		console.error(error);

		$("dashboardStatus").textContent =
			"Unable to retrieve sessions: " + error.message;
	}
}

function renderSessionList() {
	const list = $("sessionList");
	list.replaceChildren();

	if (!sessions.length) {
		list.append(
			element("p", "", "No saved quiz sessions yet.")
		);
		return;
	}

	// group sessions by device, newest activity first
	const groups = new Map();

	for (const session of sessions) {
		const key = session.deviceId || "unknown";

		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(session);
	}

	for (const [key, items] of groups) {
		const label = items[0].device?.label || "Unknown device";
		const tag = key === "unknown" ? "" : ` (${key.slice(0, 8)})`;

		list.append(element(
			"div",
			"admin-muted",
			`${label}${tag} · ${items.length} session${items.length === 1 ? "" : "s"}`
		));

		items.forEach((session, index) => {
			const progress = getProgress(session);

			const selected =
				selectedSession?.id === session.id;

			const button = element(
				"button",
				"session-button" + (selected ? " selected" : "")
			);

			button.type = "button";

			const heading = element(
				"strong",
				"",
				`Session ${index + 1}` + (session.completed ? " · finished" : "")
			);

			const description = element(
				"div",
				"admin-muted",
				`${progress.core}/15 core · ` +
				`${progress.optional}/${progress.optionalAsked} optional · ` +
				formatDate(session.updatedAt)
			);

			button.append(heading, description);

			button.onclick = () => showSession(session);

			list.append(button);
		});
	}
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
		life_drain: ['Life drain', 'You like draining life from opponents and gaining it back yourself.'],
		burn: ['Burn', 'You like finishing opponents off with spells that deal damage straight to them.'],
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

// readable names for the frustration categories (display only, the scoring keys stay the same)
const FRUSTRATION = {
	loss_creatures: "Losing creatures she built up",
	loss_options: "Running out of cards and options",
	loss_early: "Falling behind early",
	loss_setup: "Not drawing the cards she needs",
	startup_frustration: "Slow starts"
};

function scoreRow(label, stat) {
	const row = element("div", "score-row");
	const header = element("div", "score-header");

	header.append(
		element("span", "", label),
		element("strong", "", `${stat.percent}%`)
	);

	const track = element("div", "track");
	const fill = element("div", "fill");

	fill.style.width = `${stat.percent}%`;
	track.append(fill);

	row.append(
		header,
		track,
		element(
			"div",
			"details",
			`Strength ${stat.percent}% · ${stat.opportunities} question${stat.opportunities === 1 ? "" : "s"} · ${stat.confidence}`
		)
	);

	return row;
}

function renderFrustrations(target, session, stats) {
	const responses = session.responses || {};
	const group = element("div", "group");

	group.append(element("h3", "", "Most Frustrated By"));

	const question = questionById("O18");
	const ranking = responses.O18;

	if (question && isValidResponse(question, ranking)) {
		group.append(element(
			"p",
			"admin-muted",
			"Her own ranking of setbacks, from most to least frustrating:"
		));

		ranking.forEach((index, position) => {
			const suffix =
				position === 0 ? "  (most frustrating)" :
				position === ranking.length - 1 ? "  (least frustrating)" : "";

			group.append(element(
				"p",
				"",
				`${position + 1}. ${question.answers[index].text}${suffix}`
			));
		});
	} else {
		group.append(element("p", "admin-muted", "No answer to the setback ranking yet."));
	}

	const slow = stats.startup_frustration;

	if (slow?.opportunities) {
		group.append(element(
			"p",
			"admin-muted",
			"How much slow starts bother her (from the slow start question):"
		));
		group.append(scoreRow(FRUSTRATION.startup_frustration, slow));
	}

	target.append(group);
}

function renderScores(session) {
	const target = $("adminScores");
	target.replaceChildren();

	const stats = calculateScores(session.responses || {});

	target.append(buildResultSummary(stats, element));

	renderFrustrations(target, session, stats);

	target.append(element("h3", "", "Full Category Breakdown"));

	for (const [groupName, categories] of Object.entries(bank.categories)) {
		const group = element("div", "group");
		group.append(element("h3", "", groupName));

		// the frustration categories have their own section above
		const ranked = [...categories]
			.filter(category => !(category in FRUSTRATION))
			.sort((a, b) =>
				stats[b].rankScore - stats[a].rankScore || stats[b].percent - stats[a].percent
			);

		for (const category of ranked) {
			group.append(scoreRow(category.replaceAll("_", " "), stats[category]));
		}

		target.append(group);
	}
}

function renderAnswers(session) {
	const target = $("adminAnswers");
	target.replaceChildren();

	const responses = session.responses || {};

	const answered = bank.questions.filter(
		q => isValidResponse(q, responses[q.id])
	);

	if (!answered.length) {
		target.append(element("p", "", "No answers yet."));
		return;
	}

	for (const question of answered) {
		const row = element("div", "admin-row");

		row.append(
			element(
				"strong",
				"",
				`${question.id}: ${question.question}`
			)
		);

		const response = element(
			"p",
			"",
			getAnswerText(question, responses[question.id])
		);

		response.style.whiteSpace = "pre-line";
		row.append(response);

		target.append(row);
	}
}

function showSession(session) {
	selectedSession = session;

	const progress = getProgress(session);

	// open the session on its own screen instead of below the list
	$("sessionList").classList.add("hidden");
	$("sessionDetails").classList.remove("hidden");
	$("sessionTitle").textContent = "Session Details";
	window.scrollTo(0, 0);

	$("sessionInfo").textContent =
		`Session ID: ${session.id}\n` +
		`Answered: ${progress.core}/15 core, ` +
		`${progress.optional}/${progress.optionalAsked} optional\n` +
			`Device: ${session.device?.label || "Unknown device"}` +
			(session.deviceId ? ` (${session.deviceId.slice(0, 8)})\n` : "\n") +
			`Screen: ${session.device?.screen || "?"} · ${session.device?.timezone || "?"}\n` +
			`Finished: ${session.completed ? "yes" : "not yet"}\n` +
		`Updated: ${formatDate(session.updatedAt)}`;

	$("sessionInfo").style.whiteSpace = "pre-line";

	renderScores(session);
	renderAnswers(session);
	renderSessionList();
}

async function copySelectedSession() {
	if (!selectedSession) return;

	const exportData = {
		sessionId: selectedSession.id,
		questionBankVersion: selectedSession.questionBankVersion,
		responses: selectedSession.responses,
		history: selectedSession.history,
		scores: calculateScores(selectedSession.responses || {})
	};

	try {
		await navigator.clipboard.writeText(
			JSON.stringify(exportData, null, 2)
		);

		$("copySessionBtn").textContent = "Copied";

	} catch (error) {
		alert("Could not copy session data.");
	}
}

async function initialize() {
	const response = await fetch("./questions.json");

	if (!response.ok) {
		throw new Error("Could not load questions.json");
	}

	bank = await response.json();

	if (!Array.isArray(bank.questions)) {
		throw new Error("Invalid question bank format.");
	}

	$("loginForm").addEventListener("submit", async event => {
		event.preventDefault();

		$("loginError").textContent = "";

		try {
			await signInWithEmailAndPassword(
				auth,
				$("email").value,
				$("password").value
			);

			$("password").value = "";

		} catch (error) {
			$("loginError").textContent =
				"Sign-in failed. Check your credentials.";
			console.error(error);
		}
	});

	$("refreshBtn").onclick = loadSessions;

	$("backToListBtn").onclick = () => {
		selectedSession = null;
		$("sessionDetails").classList.add("hidden");
		$("sessionList").classList.remove("hidden");
		$("copySessionBtn").textContent = "Copy Session Data";

		renderSessionList();
		window.scrollTo(0, 0);
	};
	$("copySessionBtn").onclick = copySelectedSession;

	$("logoutBtn").onclick = async () => {
		await signOut(auth);
	};

	onAuthStateChanged(auth, async user => {
		if (user?.uid === ADMIN_UID) {
			$("loginPanel").classList.add("hidden");
			$("dashboard").classList.remove("hidden");

			await loadSessions();

		} else {
			$("dashboard").classList.add("hidden");
			$("loginPanel").classList.remove("hidden");

			sessions = [];
			selectedSession = null;
			$("sessionList").replaceChildren();
			$("sessionList").classList.remove("hidden");
			$("sessionDetails").classList.add("hidden");

			if (user) {
				$("loginError").textContent =
					"This account does not have admin access.";
			}
		}
	});
}

initialize().catch(error => {
	console.error(error);

	$("loginError").textContent =
		"Unable to initialize dashboard: " + error.message;
});