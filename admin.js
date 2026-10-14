
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
		return Number.isInteger(response)
			&& response >= 1
			&& response <= 10;
	}

	return Number.isInteger(response)
		&& response >= 0
		&& response < question.answers.length;
}

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
				const weights = [1, 0.55, 0.15, -0.2];

				response.forEach((index, position) => {
					add(
						question.answers[index].scores,
						weights[position] || 0
					);
				});

			} else if (question.type === "select") {
				response.forEach(index => {
					add(
						question.answers[index].scores,
						1 / response.length
					);
				});

			} else {
				add(question.answers[response].scores, 1);
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
		stat.percent = Math.max(
			0,
			Math.min(
				100,
				Math.round(
					50 + 50 * stat.points / (stat.exposure + 5)
				)
			)
		);

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

	return { core, optional, total: core + optional };
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

	sessions.forEach((session, index) => {
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
			`Session ${index + 1}`
		);

		const description = element(
			"div",
			"admin-muted",
			`${progress.core}/15 core · ` +
			`${progress.optional}/25 optional · ` +
			formatDate(session.updatedAt)
		);

		button.append(heading, description);

		button.onclick = () => showSession(session);

		list.append(button);
	});
}

function renderScores(session) {
	const target = $("adminScores");
	target.replaceChildren();

	const stats = calculateScores(session.responses || {});

	for (const [groupName, categories] of Object.entries(bank.categories)) {
		const group = element("div", "group");
		group.append(element("h3", "", groupName));

		const ranked = categories
			.filter(category => stats[category]?.opportunities > 0)
			.sort((a, b) =>
				stats[b].percent - stats[a].percent
			);

		for (const category of ranked) {
			const stat = stats[category];

			const row = element("div", "score-row");
			const header = element("div", "score-header");

			header.append(
				element("span", "", category.replaceAll("_", " ")),
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
					`${stat.opportunities} questions · ${stat.confidence}`
				)
			);

			group.append(row);
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

	$("sessionDetails").classList.remove("hidden");
	$("sessionTitle").textContent = "Session Details";

	$("sessionInfo").textContent =
		`Session ID: ${session.id}\n` +
		`Answered: ${progress.core}/15 core, ` +
		`${progress.optional}/25 optional\n` +
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
