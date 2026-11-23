(() => {
  const calculator = document.querySelector('.print-calculator');
  const width = document.querySelector('#print-width');
  const height = document.querySelector('#print-height');
  const paper = document.querySelector('#print-paper');
  const target = document.querySelector('#print-target');
  const results = calculator.querySelector('.print-results');
  const format = new Intl.NumberFormat('en', { maximumFractionDigits: 2 });

  function line(label, value) {
    const paragraph = document.createElement('p');
    const heading = document.createElement('strong');
    heading.textContent = label;
    paragraph.append(heading, ' ', value);
    return paragraph;
  }

  function update() {
    if ([width, height, target].some(input => !input.validity.valid)) {
      results.textContent = 'Enter whole pixel dimensions from 1 to 1,000,000 and a target from 1 to 2,400 ppi.';
      return;
    }

    const photoWidth = width.valueAsNumber;
    const photoHeight = height.valueAsNumber;
    const targetPpi = target.valueAsNumber;
    const [paperLong, paperShort] = paper.value === 'a4'
      ? [297 / 25.4, 210 / 25.4]
      : paper.value.split(',').map(Number);
    const [paperWidth, paperHeight] = photoWidth >= photoHeight
      ? [paperLong, paperShort]
      : [paperShort, paperLong];
    // Suppress conversion noise at exact thresholds, such as 254 ppi on A4.
    const fillPpi = Number(Math.min(photoWidth / paperWidth, photoHeight / paperHeight).toPrecision(13));
    const kept = (fillPpi * paperWidth / photoWidth) * (fillPpi * paperHeight / photoHeight);
    const printableWidth = photoWidth / targetPpi;
    const printableHeight = photoHeight / targetPpi;
    const dimension = value => value < 0.01 ? '<0.01' : format.format(value);
    const resolution = fillPpi >= targetPpi ? 'meets the target' : 'below the target';

    results.replaceChildren(
      line('Print without further cropping.',
        `${dimension(printableWidth)} × ${dimension(printableHeight)} in at ${format.format(targetPpi)} ppi.`),
      line('Fill the selected paper.',
        `${dimension(Math.floor(fillPpi * 100) / 100)} ppi (${resolution}). About ${dimension(kept * 100)}% of the entered photo area remains.`)
    );
  }

  calculator.addEventListener('input', update);
  calculator.addEventListener('change', update);
  update();
  calculator.hidden = false;
})();
