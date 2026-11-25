# Shared UI

Cross-app UI package boundary. The current single web consumer keeps accessible Radix dialogs and shadcn-style button primitives in apps/web/components/ui. TanStack Query, Zustand, React Hook Form/Zod, Recharts and Tailwind are used by the real panel. No fixture data is shipped in runtime views. Extraction into this package can follow when there is a second UI consumer.
