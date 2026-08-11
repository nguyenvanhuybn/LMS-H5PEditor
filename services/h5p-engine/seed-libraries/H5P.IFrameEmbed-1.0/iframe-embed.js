var H5P = H5P || {};

H5P.IFrameEmbed = function (options, contentId) {
  var $ = H5P.jQuery;
  var $iframe = null;
  this.$ = $(this);

  options = H5P.jQuery.extend({
    width: "500px",
    minWidth: "300px",
    height: "500px",
    source: "",
    resizeSupported: true
  }, options);

  if (!this instanceof H5P.IFrameEmbed){
    return new H5P.IFrameEmbed(options, contentId);
  }

  this.attach = function ($wrapper) {
    var iFrameSource = '';

    if (options.source !== undefined) {
      if (options.source.trim().toLowerCase().substring(0, 4) === 'http') {
        iFrameSource = options.source;
      }
      else {
        iFrameSource = H5P.getContentPath(contentId) + '/' + options.source;
      }
    }

    iFrameSource = new DOMParser().parseFromString(iFrameSource, 'text/html').documentElement.textContent;
    iFrameSource = encodeURI(iFrameSource);

    $iframe = $('<iframe/>', {
      src: iFrameSource,
      scrolling: 'no',
      frameBorder: 0,
      'class': 'h5p-iframe-content h5p-iframe-wrapper',
      css: {
        width: options.width,
        height: options.height,
        display: 'block'
      }
    });

    $wrapper.html('');
    $wrapper.append($iframe);

    if(options.resizeSupported === false) {
      setTimeout(function () {
        $('.h5p-enable-fullscreen').hide();
      }, 1);
    }

    this.$.trigger('resize');
  };

  this.resize = function () {
    if(options.resizeSupported && $iframe) {
      $iframe.css(
        (H5P.isFullscreen) ? {width: '100%', height: '100%'} : getElementSize($iframe)
      );
    }
  };

  if (options.resizeSupported && this.on !== undefined) {
    this.on('resize', this.resize);
  }

  var getElementSize = function ($element) {
    var elementMinWidth = parseInt(options.minWidth ,10);
    var elementSizeRatio = parseInt(options.height, 10) / parseInt(options.width, 10);
    var parentWidth = $element.parent().width();
    var elementWidth = (parentWidth > elementMinWidth) ? parentWidth : elementMinWidth;

    return {
      width: elementWidth + 'px',
      height: elementWidth * elementSizeRatio + 'px'
    };
  };

  window.addEventListener("touchstart", function () {});
};
