# 代码换行自检样例

下面几段代码都有很长的行，用来验证「代码自动换行」开关。

## 1. 超长单行（无空格）

```text
const data = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
```

## 2. 超长 URL

```text
https://example.com/very/long/path/that/has/no/spaces/at/all?query=parameter&another=parameter&third=parameter&fourth=parameter&fifth=parameter
```

## 3. 长代码行（正常代码）

```javascript
function calculateTotal(items, taxRate, discount, shippingCost, insuranceFee, membershipDiscount) {
    const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    return subtotal * (1 + taxRate) - discount + shippingCost + insuranceFee - membershipDiscount;
}
```

## 4. 短行（不受影响）

```text
短
行
```

## 5. 表格里的长代码

| 项目 | 值 |
|---|---|
| 长代码 | `const x = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";` |
