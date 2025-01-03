const globals = require("globals"); // Required for defining global variables

module.exports = [
  {
    files: ["*.js", "*.vue"], // Specify which files to apply this config to
    languageOptions: {
      ecmaVersion: 2020,
      parser: require("@babel/eslint-parser"), // Use Babel parser
      globals: {
        ...globals.browser, // Apply browser global variables for Vue.js
        ...globals.node, // Apply Node.js global variables for backend
      },
    },
    plugins: {
      vue: require("eslint-plugin-vue"), // Vue plugin
      prettier: require("eslint-plugin-prettier"),
    },
    rules: {
      "prettier/prettier": "off",
      "vue/multi-word-component-names": "off",
      "no-console": process.env.NODE_ENV === "production" ? "warn" : "off",
      "no-debugger": process.env.NODE_ENV === "production" ? "warn" : "off",
      quotes: ["error", "double"],
    },
  },
];
