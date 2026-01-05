
const gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
const lcm = (a, b) => (a === 0 || b === 0) ? Math.max(a, b) : Math.abs((a * b) / gcd(a, b));

const nodes = [
    { duration: 44100, isRecording: false },   // 1Q
    { duration: 176400, isRecording: false },  // 4Q
    { duration: 132300.00001, isRecording: false } // 3Q + jitter
];

let effectiveQ = 44100;
let committedLCM = effectiveQ;

nodes.forEach(n => {
    if (!n.isRecording && n.duration > 0) {
        // Rounding logic as implemented in app.js
        committedLCM = lcm(Math.round(committedLCM), Math.round(n.duration));
    }
});

console.log("Committed LCM:", committedLCM);
if (committedLCM === 529200) {
    console.log("PASS: Jitter ignored, 12Q established.");
} else {
    console.log("FAIL: Expected 529200, got", committedLCM);
    process.exit(1);
}
