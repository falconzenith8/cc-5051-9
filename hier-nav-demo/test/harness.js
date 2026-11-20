// 测试框架：极简断言与用例注册，零依赖。
let passed = 0;
let failed = 0;
const failures = [];
const pending = [];

export function test(name, fn) {
  const p = Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ✓ ${name}`);
    })
    .catch((err) => {
      failed++;
      failures.push({ name, err });
      console.log(`  ✗ ${name}\n      ${err.message}`);
    });
  pending.push(p);
  return p;
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
export function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg ?? 'equality'}: expected ${e}, got ${a}`);
}

export async function summary() {
  await Promise.all(pending);
  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  if (failed) {
    for (const f of failures) console.error(`\n[${f.name}]`, f.err.stack);
    process.exitCode = 1;
  }
}
