module.exports = {
  schemaVersion: 1,
  store: {
    id: "store-demo-001",
    name: "松月食堂",
    address: "",
    phone: "",
    businessHours: "10:00-22:00",
    notice: "欢迎光临，现点现做。"
  },
  catalog: [
    {
      id: "signature",
      name: "主打推荐",
      products: [
        {
          id: "meal-1",
          name: "门店招牌饭",
          description: "项目演示商品，请替换为真实商品",
          priceCents: 2800,
          priceText: "28.00",
          badge: "本店招牌",
          icon: "★",
          available: true
        },
        {
          id: "meal-2",
          name: "时令小食拼盘",
          description: "清爽搭配，适合分享",
          priceCents: 1600,
          priceText: "16.00",
          badge: "人气推荐",
          icon: "✳",
          available: true
        }
      ]
    },
    {
      id: "drinks",
      name: "饮品与小食",
      products: [
        {
          id: "drink-1",
          name: "自选鲜泡茶",
          description: "每日现泡",
          priceCents: 1000,
          priceText: "10.00",
          badge: "每日现泡",
          icon: "◇",
          available: true
        }
      ]
    }
  ],
  fulfillmentOptions: {
    dineIn: true,
    takeaway: true,
    delivery: false
  },
  capabilities: {
    configured: [],
    available: [],
    pendingImplementation: []
  },
  theme: {
    id: "citrus",
    colors: ["#FAF7F1", "#E78A35", "#286957", "#29332F"]
  },
  icons: [],
  demoPaymentDisclaimer: "演示模板不包含真实订单后端或微信支付。"
};