import { initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";

import {
	getAuth,
	signInAnonymously
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";

import {
	getFirestore,
	doc,
	getDoc,
	setDoc,
	serverTimestamp
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";

// Firebase web configuration
const firebaseConfig = {
	apiKey: "AIzaSyBjQtmuR8InViQqdAXNyoLK87jUXpBGj7g",
	authDomain: "mtgplaystyler.firebaseapp.com",
	projectId: "mtgplaystyler",
	storageBucket: "mtgplaystyler.firebasestorage.app",
	messagingSenderId: "48485613789",
	appId: "1:48485613789:web:35a10c16e5e1dd9e80db34"
};

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);

let sessionRef = null;
let saveQueue = Promise.resolve();

// ---- device identity ----
// A browser login (the anonymous user) changes whenever site data is cleared or a
// private window is used. This ID is kept in localStorage, a cookie and IndexedDB,
// so the admin can group sessions that came from the same device.
const DEVICE_KEY = "magic-device-id";

function readCookie() {
	const match = document.cookie.match(/(?:^|; )magic-device-id=([^;]+)/);
	return match ? decodeURIComponent(match[1]) : null;
}

function writeCookie(id) {
	document.cookie =
		`magic-device-id=${encodeURIComponent(id)}; max-age=63072000; path=/; SameSite=Lax`;
}

function openDeviceDb() {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open("magic-device", 1);

		request.onupgradeneeded = () => request.result.createObjectStore("kv");
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

async function idbGet() {
	try {
		const db = await openDeviceDb();

		return await new Promise(resolve => {
			const request = db.transaction("kv").objectStore("kv").get(DEVICE_KEY);

			request.onsuccess = () => resolve(request.result || null);
			request.onerror = () => resolve(null);
		});
	} catch {
		return null;
	}
}

async function idbSet(id) {
	try {
		const db = await openDeviceDb();

		db.transaction("kv", "readwrite").objectStore("kv").put(id, DEVICE_KEY);
	} catch {
		// the other two copies still work
	}
}

function readStoredId() {
	let fromStorage = null;

	try {
		fromStorage = localStorage.getItem(DEVICE_KEY);
	} catch {
		// storage can be blocked
	}

	return fromStorage || readCookie();
}

function rememberId(id) {
	try {
		localStorage.setItem(DEVICE_KEY, id);
	} catch {
		// storage can be blocked
	}

	writeCookie(id);
	idbSet(id);
}

let deviceId = readStoredId();

// Run once at startup: adopt a copy from IndexedDB if the others are gone,
// otherwise make a new ID, then write it everywhere.
async function settleDeviceId() {
	if (!deviceId) deviceId = await idbGet();
	if (!deviceId) deviceId = crypto.randomUUID();

	rememberId(deviceId);
}

function describeDevice() {
	const ua = navigator.userAgent;

	const os =
		/iPhone|iPad|iPod/.test(ua) ? "iOS" :
		/Android/.test(ua) ? "Android" :
		/Windows/.test(ua) ? "Windows" :
		/Mac OS X|Macintosh/.test(ua) ? "macOS" :
		/CrOS/.test(ua) ? "ChromeOS" :
		/Linux/.test(ua) ? "Linux" : "Unknown OS";

	const browser =
		/Edg\//.test(ua) ? "Edge" :
		/OPR\/|Opera/.test(ua) ? "Opera" :
		/Firefox\//.test(ua) ? "Firefox" :
		/Chrome\//.test(ua) ? "Chrome" :
		/Safari\//.test(ua) ? "Safari" : "Unknown browser";

	const kind = /Mobi|iPhone|Android.*Mobile/.test(ua) ? "phone" :
		/iPad|Tablet|Android/.test(ua) ? "tablet" : "computer";

	let timezone = "";

	try {
		timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
	} catch {
		// not important
	}

	return {
		label: `${os} · ${browser} · ${kind}`,
		os,
		browser,
		kind,
		screen: `${screen.width}x${screen.height}`,
		language: String(navigator.language || "").slice(0, 20),
		timezone: timezone.slice(0, 40)
	};
}

export async function initializeCloud() {
	await settleDeviceId();

	// Restore an existing Firebase identity if one exists.
	await auth.authStateReady();

	const user = auth.currentUser ||
		(await signInAnonymously(auth)).user;

	sessionRef = doc(db, "quizSessions", user.uid);

	console.log("Firebase session:", user.uid);

	// Retrieve previous quiz progress.
	const snapshot = await getDoc(sessionRef);

	return snapshot.exists() ? snapshot.data() : null;
}

export function saveCloud(state) {
	if (!sessionRef) return Promise.resolve();

	// Capture the state at the moment of saving.
	const snapshot = structuredClone(state);

	// Serialize writes so older requests cannot finish after
	// newer requests and overwrite more recent answers.
	saveQueue = saveQueue
		.catch(() => {})
		.then(() => setDoc(sessionRef, {
			...snapshot,
			deviceId,
			device: describeDevice(),
			updatedAt: serverTimestamp()
		}))
		.catch(error => {
			console.error("Firebase save failed:", error);

			// The local copy still exists.
			// A later save or reconnect can retry.
		});

	return saveQueue;
}

export function getSessionId() {
	return auth.currentUser?.uid || null;
}