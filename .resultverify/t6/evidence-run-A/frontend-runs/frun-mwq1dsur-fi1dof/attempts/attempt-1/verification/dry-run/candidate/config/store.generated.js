// 由 Composer 生成，勿手改。
module.exports = {
  "schemaVersion": 2,
  "meta": {
    "configSchemaVersion": 2,
    "storeConfigVersion": 1,
    "catalogVersion": 1,
    "apiContractVersion": "storefront.v1",
    "recipeId": "order-classic",
    "recipeVersion": "1.0.0",
    "lockDigest": "sha256:9bfaa4e380aa8f4d01689b46f5572d3207d62d46edc836697a2c4ca6e8dcf1eb",
    "generatedAt": "1970-01-01T00:00:00Z",
    "generatorVersion": "0.1.0",
    "planDigest": "sha256:2c6ebe935364f1d728924eeb92a55c797b1054039819cac42053960a00994a88",
    "mode": "development",
    "versionGaps": {
      "storeConfigVersion": 1,
      "catalogVersion": 1
    },
    "frontendPackId": "fr-251f19338c2e",
    "frontendPackVersion": "1.0.0"
  },
  "store": {
    "name": "T6链路验证店",
    "category": "社区餐馆",
    "address": "",
    "phone": "",
    "notes": "",
    "businessHours": [
      {
        "start": "09:00",
        "end": "21:00"
      }
    ],
    "id": "store-preview-27277cb00ad8a444467920e524bd2c40"
  },
  "api": {
    "baseUrl": "http://127.0.0.1:3000/api/v1",
    "contract": "storefront.v1",
    "timeoutMs": 10000
  },
  "catalog": {
    "mode": "remote",
    "version": 1,
    "categories": [],
    "products": []
  },
  "fulfillmentOptions": {
    "dineIn": true,
    "takeaway": true,
    "delivery": false
  },
  "theme": {
    "pageBackground": "#F7F3EC",
    "primaryColor": "#B34A0F",
    "accentColor": "#9C2E12",
    "textColor": "#232323",
    "tabBarBackground": "#FFFDF9",
    "tabBarColor": "#8A8178",
    "tabBarSelectedColor": "#B34A0F"
  },
  "capabilities": {
    "onlineReady": [],
    "previewOnly": []
  },
  "demoPaymentDisclaimer": "演示付款，不产生真实扣款"
};
