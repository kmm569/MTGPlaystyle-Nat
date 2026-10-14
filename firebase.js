
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

export async function initializeCloud() {
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
