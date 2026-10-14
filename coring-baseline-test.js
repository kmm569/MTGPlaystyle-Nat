(async () => {
	while (!window.commanderTests) {
		await new Promise(resolve => setTimeout(resolve, 100));
	}

	const tests = window.commanderTests;

	// Rest of the baseline test code goes here.
})();