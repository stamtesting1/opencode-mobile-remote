// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require("eslint/config");
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*", ".expo/*", ".expo-export/*", "android/*", "ios/*"],
    rules: {
      // The import plugin's TypeScript resolver does not support the TypeScript 6
      // line this SDK ships, and these rules crash the lint run when they fail.
      "import/namespace": "off",
      "import/named": "off",
      "import/default": "off",
      "import/no-named-as-default": "off",
      "import/no-named-as-default-member": "off",
      "import/no-duplicates": "off",
    },
  },
]);