// @whitepay/vue (Vue 3): <PayButton host="https://pay.example.com" :payment-id="payment.id" @paid="…">Pay with USDT</PayButton>
// Events are for UX only. Ship goods only after your server sees the `payment.fulfillable` webhook.
import { defineComponent, h, onMounted, ref } from "vue";
import { loadWidget, openCheckout } from "./loader.js";

export { loadWidget, openCheckout };

export const PayButton = defineComponent({
  name: "WhitePayButton",
  props: {
    host: { type: String, required: true }, paymentId: String, invoiceId: String,
    mode: { type: String, default: "modal" }, lang: String,
  },
  emits: ["paid", "status", "close", "error"],
  setup(props, { emit, slots }) {
    const ready = ref(false);
    onMounted(() => loadWidget(props.host).then(() => (ready.value = true)).catch((e) => emit("error", e)));
    const click = () => openCheckout(props.host, props.paymentId || props.invoiceId, {
      mode: props.mode, lang: props.lang, onPaid: (s) => emit("paid", s), onStatus: (s) => emit("status", s), onClose: () => emit("close"),
    }).catch((e) => emit("error", e));
    return () => h("button", { type: "button", disabled: !ready.value || !(props.paymentId || props.invoiceId), onClick: click },
      slots.default ? slots.default() : props.invoiceId ? "Pay invoice with USDT" : "Pay with USDT");
  },
});

export default { install(app) { app.component("WhitePayButton", PayButton); } };
