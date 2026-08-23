# session sharegpt_BYHT3Xz_0 — 2023-05-26 (2023/05/26 (Fri) 07:17)

date: 2023/05/26 (Fri) 07:17
iso_date: 2023-05-26

user: how do i create a custom wordpress block with a heading, paragraph, and image?

assistant: Creating a custom WordPress block with a heading, paragraph, and image requires some basic knowledge of HTML, CSS, and JavaScript. Here are the steps to create your custom block:

1. Create a new directory in your WordPress theme or plugin, for example, `my-custom-block`.
2. Create a new file `index.js` in the directory and add the following code:
```javascript
import { registerBlockType } from '@wordpress/blocks';
import { RichText, MediaUpload, BlockControls, AlignmentToolbar } from '@wordpress/block-editor';
import { Button } from '@wordpress/components';

registerBlockType( 'my-custom-block/custom-block', {
    title: 'Custom Block',
    icon: 'format-image',
    category: 'common',
    attributes: {
        heading: {
            type: 'string',
            source: 'html',
            selector: 'h2',
        },
        paragraph: {
            type: 'string',
            source: 'html',
            selector: 'p',
        },
        imageURL: {
            type: 'string',
            default: 'https://via.placeholder.com/150',
        },
        imageID: {
            type: 'number',
        },
        imageAlt: {
            type: 'string',
        },
        alignment: {
            type: 'string',
            default: 'center',
        },
    },
    edit( { attributes, setAttributes } ) {
        const { heading, paragraph, imageURL, imageID, imageAlt, alignment } = attributes;

        function onSelectImage( media ) {
            setAttributes( {
                imageID: media.id,
                imageURL: media.url,
                imageAlt: media.alt,
            } );
        }

        function onChangeHeading( value ) {
            setAttributes( { heading: value } );
        }

        function onChangeParagraph( value ) {
            setAttributes( { paragraph: value } );
        }

        function onChangeAlignment( newAlignment ) {
            setAttributes( { alignment: newAlignment === undefined ? 'center' : newAlignment } );
        }

        return (
            <div className="my-custom-block">
                <BlockControls>
                    <AlignmentToolbar
                        value={ alignment }
                        onChange={ onChangeAlignment }
                    />
                </BlockControls>
                <RichText
                    tagName="h2"
                    value={ heading }
                    onChange={ onChangeHeading }
                    placeholder="Enter heading"
                />
                <MediaUpload
                    onSelect={ onSelectImage }
                    allowedTypes={ [ 'image' ] }
                    value={ imageID }
                    render={ ( { open } ) => (
                        <Button onClick={ open }>
                            { ! imageURL ? 'Upload Image' : <img src={ imageURL } alt={ imageAlt } /> }
                        </Button>
                    ) }
                />
                <RichText
                    tagName="p"
                    value={ paragraph }
                    onChange={ onChangeParagraph }
                    placeholder="Enter paragraph"
                />
            </div>
        );
    },
    save( { attributes } ) {
        const { heading, paragraph, imageURL, imageAlt, alignment } = attributes;

        return (
            <div className={ `my-custom-block align${ alignment }` }>
                <RichText.Content
                    tagName="h2"
                    value={ heading }
                />
                <img src={ imageURL } alt={ imageAlt } />
                <RichText.Content
                    tagName="p"
                    value={ paragraph }
                />
            </div>
        );
    },
} );
```
3. In the code above, we're importing some necessary WordPress blocks components such as `RichText`, `MediaUpload`, `BlockControls`, and `AlignmentToolbar`. We also define our block's title, icon, and category, as well as its attributes such as `heading`, `paragraph`, `imageURL`, `image

user: what about css?

assistant: To style your custom block, you can add a `style.css` file in the same directory as your `index.js` file. Here's an example of how you can style your custom block:
```css
.my-custom-block {
    margin: 20px 0;
}

.my-custom-block img {
    max-width: 100%;
}

.my-custom-block h2 {
    font-size: 24px;
    margin-bottom: 10px;
}

.my-custom-block p {
    font-size: 16px;
    line-height: 1.5;
}
```
In this example, we're using some basic CSS rules to style our custom block. We're setting a margin for the block, a max-width for the image, and some font styles for the heading and paragraph.

To include the CSS in your WordPress site, you can enqueue the stylesheet in your theme or plugin's `functions.php` file using the `wp_enqueue_style()` function. Here's an example:
```javascript
function my_custom_block_enqueue() {
    wp_enqueue_style(
        'my-custom-block-style',
        plugins_url( 'my-custom-block/style.css' )
    );
}
add_action( 'enqueue_block_editor_assets', 'my_custom_block_enqueue' );
```
In this example, we're using the `wp_enqueue_style()` function to enqueue the `style.css` file in our custom block directory. The `plugins_url()` function returns the URL of the plugin or theme directory. We're also hooking our function to the `enqueue_block_editor_assets` action to ensure that our styles are loaded in the block editor.
