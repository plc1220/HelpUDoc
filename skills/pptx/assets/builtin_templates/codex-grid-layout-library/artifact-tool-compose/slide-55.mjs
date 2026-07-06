import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide55Tokens = contentTokens["slide-55"];

export function buildSlide55(presentation, tokens = slide55Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-55", width: "fill", height: "fill" }, [
      text([{ runs: [tokens.footer1] }], {
        name: "Google-Shape-532-p58",
        ...frame({ left: "1184px", top: "659px", width: "54px", height: "25px" }),
        style: textStyles.helveticaNeueFont15MiddleRightColorTx1,
      }),
      text([tokens.body1.titleHere, tokens.body1.loremIpsumDolorSitAmetConsecteturAdipiscing, tokens.body1.nullamPharetraMaurisTortorInHacHabitasse], {
        name: "Content-Placeholder-1",
        ...frame({ left: "453px", top: "43px", width: "375px", height: "379px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      text([tokens.body2.titleHere, tokens.body2.loremIpsumDolorSitAmetConsecteturAdipiscing, tokens.body2.nullamPharetraMaurisTortorInHacHabitasse], {
        name: "Content-Placeholder-2",
        ...frame({ left: "864px", top: "43px", width: "375px", height: "379px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      text([tokens.title], {
        name: "Google-Shape-533-p58",
        ...frame({ left: "41px", top: "525px", width: "616px", height: "104px" }),
        style: textStyles.helveticaNeueFont39TopColorTx1,
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}
