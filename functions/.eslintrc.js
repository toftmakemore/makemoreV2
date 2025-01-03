module.exports = {
  root: true,
  env: {
    es6: true,
    node: true,
    browser: true,
  },
  extends: [
    "eslint:recommended"
  ],
  parserOptions: {
    ecmaVersion: 2020,
  },
  rules: {
    "no-restricted-globals": ["error", "name", "length"],
    "no-unused-vars": "off",
    "no-console": "off",
    "no-undef": "off"
  },
  ignorePatterns: [
    "/lib/**/*",
    "/coverage/**/*",
    "**/*.d.ts",
  ],
};
