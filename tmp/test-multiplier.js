
function getMultiplier(score) {
    return score / 50;
}

const scores = [0, 25, 45, 50, 60, 75, 100];
console.log("Score Mapping (0-100 to 0-2):");
scores.forEach(s => {
    console.log(`Score: ${s.toString().padStart(3)} -> Multiplier: ${getMultiplier(s).toFixed(2)}`);
});
