// 由 Composer 生成，勿手改。
module.exports = {
  "schemaVersion": 2,
  "meta": {
    "configSchemaVersion": 2,
    "storeConfigVersion": null,
    "catalogVersion": null,
    "apiContractVersion": "storefront.v1",
    "recipeId": "ordering-base-preview",
    "recipeVersion": "0.0.0",
    "lockDigest": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    "generatedAt": "1970-01-01T00:00:00Z",
    "generatorVersion": "0.1.0",
    "planDigest": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    "mode": "development",
    "versionGaps": { "storeConfigVersion": null, "catalogVersion": null }
  },
  "store": {
    "name": "柑橘小馆",
    "category": "中式简餐",
    "address": "上海市静安区示例路 1 号",
    "phone": "13800000000",
    "notes": "",
    "businessHours": []
  },
  "api": {
    "baseUrl": "",
    "contract": "storefront.v1",
    "timeoutMs": 10000
  },
  "catalog": {
    "mode": "remote",
    "version": null,
    "categories": [],
    "products": []
  },
  "fulfillmentOptions": { "dineIn": true, "takeaway": true, "delivery": false },
  "theme": {
    "pageBackground": "#F7F3EC",
    "primaryColor": "#B34A0F",
    "accentColor": "#9C2E12",
    "textColor": "#232323",
    "tabBarBackground": "#FFFDF9",
    "tabBarColor": "#8A8178",
    "tabBarSelectedColor": "#B34A0F"
  },
  "capabilities": { "onlineReady": ["store-header", "product-card", "cart-bar"], "previewOnly": [] },
  "demoPaymentDisclaimer": "演示付款，不产生真实扣款"
};